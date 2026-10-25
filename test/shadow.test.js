import assert from 'node:assert/strict';
import test from 'node:test';
import { rng } from '../src/hash.js';
import { memoryStore } from '../src/store.js';
import { shadow } from '../src/shadow.js';
import { toyTraffic } from './helpers.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

function teacherFrom(traffic, { shape = 'string', policy = (c) => c } = {}) {
  const truth = new Map(traffic.map((r) => [r.input, r.choice]));
  const t = async (input) => {
    t.calls++;
    const c = policy(truth.get(input));
    return shape === 'string' ? c : { choice: c, confidence: 0.9 };
  };
  t.calls = 0;
  return t;
}

async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

test('passes everything through while learning, then graduates and answers locally', async () => {
  const traffic = toyTraffic(9000, { seed: 3 });
  const teacher = teacherFrom(traffic);
  const events = [];
  const decide = shadow(teacher, { log: false, random: rng(1), autoCompile: { min: 3000 }, onEvent: (e) => events.push(e.type) });

  for (const r of traffic.slice(0, 3000)) assert.equal(await decide(r.input), r.choice);
  assert.equal(teacher.calls, 3000);
  await waitFor(() => decide.mode === 'local');
  assert.ok(events.includes('compile') && events.includes('install'));

  let agree = 0;
  const before = teacher.calls;
  const rest = traffic.slice(3000);
  for (const r of rest) if ((await decide(r.input)) === r.choice) agree++;
  await settle();
  const s = decide.stats();
  assert.ok(agree / rest.length >= 0.97, `agreement ${agree / rest.length}`);
  assert.ok(s.local > rest.length * 0.5, `local ${s.local}`);
  assert.ok(teacher.calls - before < rest.length * 0.5, 'most calls stopped reaching the teacher');
  assert.ok(s.audits > 0 && s.audits < s.local * 0.05);
});

test('local answers come back in the teacher response shape', async () => {
  const traffic = toyTraffic(4000, { seed: 4 });
  const decide = shadow(teacherFrom(traffic, { shape: 'object' }), { log: false, random: rng(2), autoCompile: { min: 3000 } });
  for (const r of traffic.slice(0, 3000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  const seen = new Set();
  for (const r of traffic.slice(3000)) {
    const d = await decide.detailed(r.input);
    seen.add(d.source);
    assert.equal(typeof d.value, 'object');
    assert.equal(typeof d.value.choice, 'string');
  }
  assert.ok(seen.has('local') && seen.has('api'));
});

test('local answers mirror the keys your API uses', async () => {
  const traffic = toyTraffic(4000, { seed: 15 });
  const labels = ['billing', 'bug', 'login', 'other'];
  const truth = new Map(traffic.map((r) => [r.input, r.choice]));
  const api = async (input) => ({ label: truth.get(input), probs: labels.map((l) => (l === truth.get(input) ? 0.9 : 0.1 / 3)), reasoning: '…' });
  const decide = shadow(api, { log: false, labels, random: rng(16), autoCompile: { min: 3000 } });
  for (const r of traffic.slice(0, 3000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  let local = 0;
  for (const r of traffic.slice(3000)) {
    const d = await decide.detailed(r.input);
    if (d.source !== 'local') continue;
    local++;
    assert.deepEqual(Object.keys(d.value), ['label', 'probs']);
    assert.equal(d.value.probs.length, labels.length);
  }
  assert.ok(local > 100);
});

test('a teacher policy change trips the guard, routes to the teacher, and recovers on new traffic', async () => {
  const traffic = toyTraffic(16000, { seed: 5 });
  let changed = false;
  const remap = { billing: 'bug', bug: 'billing' };
  const teacher = teacherFrom(traffic, { policy: (c) => (changed ? remap[c] ?? c : c) });
  const guards = [];
  const decide = shadow(teacher, { log: false, random: rng(3), audit: 0.05, autoCompile: { min: 2000 }, onEvent: (e) => e.type === 'guard' && guards.push(e) });

  for (const r of traffic.slice(0, 2000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  changed = true;
  let i = 2000;
  for (; i < traffic.length && decide.mode === 'local'; i++) { await decide(traffic[i].input); await settle(); }
  assert.equal(decide.mode, 'guarded');
  assert.equal(guards[0].reason, 'drift');
  const trippedAfter = i - 2000;
  assert.ok(trippedAfter < 3000, `guard took ${trippedAfter} calls`);
  assert.ok(['audit', 'deferred'].includes(guards[0].slice));

  // While guarded, every call is the teacher's own answer.
  for (let j = 0; j < 200; j++, i++) assert.equal(await decide(traffic[i].input), remap[traffic[i].choice] ?? traffic[i].choice);
  for (; i < traffic.length && decide.mode !== 'local'; i++) { await decide(traffic[i].input); await settle(); }
  await waitFor(() => decide.mode === 'local');
  let agree = 0, m = 0;
  for (; i < traffic.length; i++, m++) if ((await decide(traffic[i].input)) === (remap[traffic[i].choice] ?? traffic[i].choice)) agree++;
  assert.ok(m > 500 && agree / m >= 0.97, `post-recovery agreement ${agree / m} over ${m}`);
});

test('a label the model has never seen sends traffic back to the teacher', async () => {
  const traffic = toyTraffic(3000, { seed: 6 });
  let fresh = false;
  const teacher = teacherFrom(traffic, { policy: (c) => (fresh ? 'refund' : c) });
  const decide = shadow(teacher, { log: false, random: () => 0, autoCompile: { min: 2500 } });
  for (const r of traffic.slice(0, 2500)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  fresh = true;
  for (const r of traffic.slice(2500, 2600)) await decide(r.input);
  await settle();
  assert.equal(decide.mode, 'guarded');
});

test('a new label joins a fixed label set and is learned after the guard trips', async () => {
  const traffic = toyTraffic(7000, { seed: 14 });
  let fresh = false;
  const teacher = teacherFrom(traffic, { policy: (c) => (fresh && c === 'other' ? 'refund' : c) });
  const decide = shadow(teacher, { log: false, labels: ['billing', 'bug', 'login', 'other'], random: rng(11), autoCompile: { min: 2000 } });
  for (const r of traffic.slice(0, 2000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  fresh = true;
  for (const r of traffic.slice(2000, 4500)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  assert.ok(decide.model.labels.includes('refund'));
});

test('fallback answers locally when the teacher is down', async () => {
  const traffic = toyTraffic(3000, { seed: 8 });
  let down = false;
  const truth = teacherFrom(traffic);
  const teacher = async (x) => { if (down) throw new Error('503'); return truth(x); };
  const decide = shadow(teacher, { log: false, fallback: true, random: rng(4), autoCompile: { min: 2500 } });
  for (const r of traffic.slice(0, 2500)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  down = true;
  const sources = new Set();
  for (const r of traffic.slice(2500, 2700)) sources.add((await decide.detailed(r.input)).source);
  assert.ok(sources.has('fallback'));
  const strict = shadow(teacher, { log: false, autoCompile: false });
  await assert.rejects(strict('anything'), /503/);
});

test('stores record sampled and deferred rows differently', async () => {
  const traffic = toyTraffic(5000, { seed: 9 });
  const store = memoryStore();
  const decide = shadow(teacherFrom(traffic), { log: false, store, random: rng(5), autoCompile: { min: 3000, growth: 100 } });
  for (const r of traffic.slice(0, 3000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  for (const r of traffic.slice(3000)) await decide(r.input);
  await settle();
  const late = store.records.slice(3000);
  assert.ok(late.some((r) => r.sample === false), 'deferred rows are training-only');
  assert.ok(late.some((r) => r.sample === undefined), 'audit rows stay sampled');
  assert.ok(store.records.slice(0, 3000).every((r) => r.sample === undefined));
});

test('a drift on deferred calls trips the guard before the audit sample can', async () => {
  // Cues decide the label; every label is mapped to the next one after the change, so the model's
  // guesses on deferred calls stop matching the teacher immediately.
  const labels = ['a', 'b', 'c', 'd'];
  const traffic = toyTraffic(12000, { seed: 12, labels, noise: 0.45 });
  let changed = false;
  const next = (c) => labels[(labels.indexOf(c) + 1) % labels.length];
  const teacher = teacherFrom(traffic, { policy: (c) => (changed ? next(c) : c) });
  const guards = [];
  const decide = shadow(teacher, { log: false, random: rng(9), audit: 0.01, autoCompile: { min: 3000 }, onEvent: (e) => e.type === 'guard' && guards.push(e) });
  for (const r of traffic.slice(0, 3000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  changed = true;
  let i = 3000;
  for (; i < traffic.length && decide.mode === 'local'; i++) await decide(traffic[i].input);
  assert.equal(decide.mode, 'guarded');
  assert.equal(guards[0].slice, 'deferred');
  assert.ok(i - 3000 < 600, `tripped after ${i - 3000} calls`);
});

test('a compile that was running when the guard tripped is never installed', async () => {
  const traffic = toyTraffic(8000, { seed: 13 });
  let changed = false;
  const teacher = teacherFrom(traffic, { policy: (c) => (changed ? 'billing' : c) });
  const events = [];
  const decide = shadow(teacher, { log: false, random: rng(10), autoCompile: { min: 2000 }, onEvent: (e) => events.push(e) });
  for (const r of traffic.slice(0, 2000)) await decide(r.input);
  await waitFor(() => decide.mode === 'local');
  // Start a compile, then change the teacher and push calls until the guard trips mid-compile.
  const pending = decide.compile();
  changed = true;
  for (let i = 2000; i < 4000 && decide.mode === 'local'; i++) await decide(traffic[i].input);
  await pending;
  assert.equal(decide.mode, 'guarded');
  assert.ok(events.some((e) => e.type === 'discard'));
  assert.equal(events.filter((e) => e.type === 'install').length, 1);
});

test('a change to one label of a realistic API is caught within a few thousand calls', async () => {
  const { supportApi } = await import('../examples/support-api.js');
  const sim = supportApi({ seed: 1 });
  const guards = [];
  let compiling = false;
  const decide = shadow(sim.api, { log: false, random: rng(7), onEvent: (e) => {
    if (e.type === 'compile:start') compiling = true;
    if (e.type === 'compile' || e.type === 'discard') compiling = false;
    if (e.type === 'guard') guards.push(e);
  } });
  let i = 0;
  for (; i < 7000; i++) { await decide(sim.next()); while (compiling) await settle(); }
  assert.equal(decide.mode, 'local');
  sim.change();
  for (; i < 12_000 && decide.mode === 'local'; i++) { await decide(sim.next()); while (compiling) await settle(); }
  assert.equal(decide.mode, 'guarded', 'the guard tripped');
  assert.ok(i - 7000 < 4000, `caught after ${i - 7000} calls`);
  assert.equal(guards.length, 1);
});
