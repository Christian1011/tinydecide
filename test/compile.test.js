import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, readRecords } from '../src/compile.js';
import { toyTraffic } from './helpers.js';

test('learns the cues, defers the noise, and keeps agreement on fresh traffic', async () => {
  const { model, report } = await compile(toyTraffic(6000), { target: 0.98 });
  assert.equal(report.verdict, 'ship');
  assert.ok(report.calib.share > 0.6 && report.calib.share < 0.95, `share ${report.calib.share}`);
  const fresh = toyTraffic(4000, { seed: 1234 });
  let local = 0, wrong = 0;
  for (const r of fresh) { const d = model.decide(r.input); if (d.local) { local++; if (d.choice !== r.choice) wrong++; } }
  assert.ok(1 - wrong / fresh.length >= 0.975, `fresh agreement ${1 - wrong / fresh.length}`);
  assert.ok(local / fresh.length > 0.6);
  assert.equal(report.test.int8Flips <= 2, true);
});

test('too little traffic says so instead of guessing', async () => {
  const { report, model } = await compile(toyTraffic(300));
  assert.equal(report.verdict, 'need-more-data');
  assert.match(report.summary, /calibration rows/);
  assert.equal(Number.isFinite(model.cutoff) ? report.calib.share : 0, report.calib.share);
});

test('an unlearnable decision is reported as not worth it', async () => {
  const { report } = await compile(toyTraffic(4000, { noise: 1 }));
  assert.equal(report.verdict, 'not-worth-it');
  assert.ok(report.calib.share < 0.05);
});

test('records accept probs maps, probs arrays with a header, index choices and pairs', () => {
  const { labels, rows } = readRecords([
    { labels: ['no', 'yes'] },
    { input: 'a', probs: [0.2, 0.8] },
    { text: 'b', choice: 0 },
    { a: 'x', b: 'y', label: 'yes' },
    { input: 'c', probs: { no: 3, yes: 1 } },
  ]);
  assert.deepEqual(labels, ['no', 'yes']);
  assert.deepEqual(rows.map((r) => r.y), [1, 0, 1, 0]);
  assert.deepEqual(Array.from(rows[3].t), [0.75, 0.25]);
  assert.deepEqual(rows[2].input, { a: 'x', b: 'y' });
});

test('rows logged only because they were deferred never reach calibration', async () => {
  const recs = toyTraffic(5000).map((r, i) => (i % 2 ? { ...r, sample: false } : r));
  const { report } = await compile(recs);
  const sampled = recs.filter((r) => r.sample !== false).length;
  assert.ok(report.rows.calib + report.rows.test <= sampled * 0.45, 'calib/test drawn only from sampled rows');
  assert.ok(report.rows.train > sampled * 0.5);
});

test('the local guarantee is stricter on the answered slice', async () => {
  const recs = toyTraffic(6000);
  const overall = (await compile(recs, { target: 0.95 })).report;
  const local = (await compile(recs, { target: 0.95, guarantee: 'local' })).report;
  assert.ok(local.calib.share <= overall.calib.share);
  assert.ok(local.calib.localAgreement >= 0.95);
});
