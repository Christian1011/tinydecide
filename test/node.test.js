import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rng } from '../src/hash.js';
import { fileStore, shadow } from '../src/node.js';
import { toyTraffic } from './helpers.js';

const temp = () => mkdtempSync(join(tmpdir(), 'tinydecide-'));

function apiFrom(traffic, policy = (c) => c) {
  const truth = new Map(traffic.map((r) => [r.input, r.choice]));
  return async (input) => policy(truth.get(input));
}

async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

test('a named decision is saved to disk, compiled in a worker, and resumes after a restart', async () => {
  const dir = join(temp(), '.tinydecide');
  const traffic = toyTraffic(4000, { seed: 21 });
  const api = apiFrom(traffic);
  const lines = [];
  const first = shadow('support', api, { dir, random: rng(1), log: (line) => lines.push(line) });
  for (const r of traffic.slice(0, 2000)) await first(r.input);
  await waitFor(() => first.mode === 'local');
  await first.close();

  const folder = join(dir, 'support');
  for (const f of ['answers.jsonl', 'model.tdm', 'report.json']) assert.ok(existsSync(join(folder, f)), f);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  assert.match(lines[0], /^\[tinydecide\] support: learning from your API\. First compile after 2,000 answers\.$/);
  assert.ok(lines.some((l) => /support: compiled from 2,000 answers: answers \d+% of calls locally/.test(l)), lines.join('\n'));

  const second = shadow('support', api, { dir, random: rng(2), log: (line) => lines.push(line) });
  await second.ready;
  assert.equal(second.mode, 'local');
  assert.match(lines.at(-1), /support: loaded the saved model/);
  const sources = new Set();
  for (const r of traffic.slice(2000, 2300)) sources.add((await second.detailed(r.input)).source);
  assert.ok(sources.has('local'), 'answers locally right after a restart');
  await second.close();
});

test('a guarded decision stays guarded across a restart', async () => {
  const dir = temp();
  const traffic = toyTraffic(2600, { seed: 22 });
  let fresh = false;
  const api = apiFrom(traffic, (c) => (fresh ? 'refund' : c));
  const first = shadow('routing', api, { dir, log: false, random: () => 0 });
  for (const r of traffic.slice(0, 2000)) await first(r.input);
  await waitFor(() => first.mode === 'local');
  fresh = true;
  for (const r of traffic.slice(2000, 2050)) await first(r.input);
  assert.equal(first.mode, 'guarded');
  await first.close();
  assert.ok(existsSync(join(dir, 'routing', 'state.json')));

  const second = shadow('routing', api, { dir, log: false });
  await second.ready;
  assert.equal(second.mode, 'guarded');
  assert.equal(await second(traffic[2100].input), 'refund');
  await second.close();
});

test('the answer log survives a crash mid-write', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'answers.jsonl'), '{"t":1,"input":"a","choice":"x"}\n{"t":2,"input":"b","cho');
  const store = fileStore(dir);
  assert.equal(store.size, 1);
  store.append({ t: 3, input: 'c', choice: 'y' });
  assert.deepEqual(store.load().map((r) => r.input), ['a', 'c']);
  store.close();
});

test('the answer log is trimmed to its limit as it grows, and only its owner can read it', () => {
  const dir = temp();
  const store = fileStore(dir, { limit: 100 });
  for (let i = 0; i < 300; i++) store.append({ t: i, input: `m${i}`, choice: 'x' });
  const lines = readFileSync(join(dir, 'answers.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length <= 125, `${lines.length} lines`);
  assert.equal(JSON.parse(lines.at(-1)).input, 'm299');
  const rows = store.load();
  assert.equal(rows.length, 100);
  assert.equal(rows[0].input, 'm200');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'answers.jsonl')).mode & 0o077, 0);
  store.close();
});

test('a failed trim leaves the log open for the next answer', () => {
  const dir = temp();
  const store = fileStore(dir, { limit: 4 });
  const blocker = join(dir, `answers.jsonl.${process.pid}.tmp`);
  mkdirSync(blocker); // the trim's temp file can't be written
  for (let i = 0; i < 5; i++) store.append({ t: i, input: `m${i}`, choice: 'x' });
  assert.throws(() => store.append({ t: 5, input: 'm5', choice: 'x' }));
  rmdirSync(blocker);
  store.append({ t: 6, input: 'after', choice: 'x' });
  assert.equal(store.load().at(-1).input, 'after');
  store.close();
});

test('a folder is used by one store at a time, and a stale lock is taken over', () => {
  const dir = temp();
  const first = fileStore(dir);
  assert.throws(() => fileStore(dir), /already open in this process/);
  first.close();
  writeFileSync(join(dir, 'lock'), '999999999'); // left by a process that is gone
  fileStore(dir).close();
});

test('a folder that cannot be opened keeps answers in memory, with one log line', async () => {
  const file = join(temp(), 'not-a-folder');
  writeFileSync(file, '');
  const lines = [];
  const decide = shadow('support', async () => 'billing', { dir: join(file, 'x'), log: (line) => lines.push(line) });
  assert.equal(await decide('hello'), 'billing');
  assert.equal(decide.stats().logged, 1);
  assert.equal(lines.filter((l) => /opening .* failed: .*Answers stay in memory\./.test(l)).length, 1, lines.join('\n'));
  await decide.close();
});

test('a failing store never fails a call, and repeats are logged once', async () => {
  const store = { append() { throw new Error('disk full'); }, load: () => [], size: 0 };
  const lines = [];
  const decide = shadow('quiet', async () => 'billing', { store, log: (line) => lines.push(line) });
  for (let i = 0; i < 50; i++) assert.equal(await decide(`call ${i}`), 'billing');
  assert.equal(lines.filter((l) => l.includes('disk full')).length, 1);
  assert.equal(decide.stats().errors, 50);
});

test('an unreadable response still passes through, with one clear log line', async () => {
  const lines = [];
  const decide = shadow('odd', async () => ({ result: { tag: 'x' } }), { log: (line) => lines.push(line) });
  assert.deepEqual(await decide('hello'), { result: { tag: 'x' } });
  await decide('again');
  const hits = lines.filter((l) => l.includes('could not find a label'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /\{"result":\{"tag":"x"\}\}.*choice: \(response\) => label/);
});

test('mistakes are explained at startup', () => {
  const api = async () => 'x';
  assert.throws(() => shadow('bad name!', api), /name must be 1–64 letters/);
  assert.throws(() => shadow('ok', 'classify'), /needs your API call as a function/);
  assert.throws(() => shadow('ok', api, { autocompile: false }), /unknown option "autocompile"/);
  assert.throws(() => shadow('ok', api, { target: 98 }), /target must be a number between 0 and 1/);
});
