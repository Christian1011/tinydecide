import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../src/compile.js';
import { Model } from '../src/model.js';
import { loadModel, saveModel } from '../src/node.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toyTraffic } from './helpers.js';

test('a compiled model survives a byte round trip unchanged', async () => {
  const { model } = await compile(toyTraffic(3000));
  const back = Model.fromBytes(model.toBytes());
  assert.deepEqual(back.labels, model.labels);
  assert.equal(back.cutoff, model.cutoff);
  assert.deepEqual(back.meta, model.meta);
  for (const r of toyTraffic(200, { seed: 99 })) assert.deepEqual(back.decide(r.input), model.decide(r.input));
});

test('bad bytes are rejected with a clear message', () => {
  assert.throws(() => Model.fromBytes(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])), /bad magic/);
});

test('decide reports probabilities and a margin', async () => {
  const { model } = await compile(toyTraffic(3000));
  const d = model.decide('w1 w2 billingx00', { probs: true });
  assert.equal(Object.keys(d.probs).length, 4);
  assert.ok(Math.abs(Object.values(d.probs).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(d.margin >= 0 && d.confidence > 0.25);
});

test('a model saved to disk loads back with identical answers', async () => {
  const { model } = await compile(toyTraffic(3000));
  const path = join(mkdtempSync(join(tmpdir(), 'tinydecide-')), 'm.tdm');
  saveModel(path, model);
  const back = loadModel(path);
  for (const r of toyTraffic(200, { seed: 98 })) assert.deepEqual(back.decide(r.input), model.decide(r.input));
  // Pooled Buffers start at a non-zero offset; loading from one must still work.
  const pooled = Buffer.concat([Buffer.alloc(13), Buffer.from(model.toBytes())]).subarray(13);
  assert.deepEqual(Model.fromBytes(pooled).decide('w1 billingx00'), model.decide('w1 billingx00'));
});
