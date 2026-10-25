import assert from 'node:assert/strict';
import test from 'node:test';
import { rng } from '../src/hash.js';
import { binomCdf, certify, localStart, minCalibration, wilson } from '../src/stats.js';

test('binomial cdf matches direct sums', () => {
  const direct = (k, n, p) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { s += c * p ** i * (1 - p) ** (n - i); c *= (n - i) / (i + 1); } return s; };
  for (const [k, n, p] of [[0, 10, 0.1], [3, 20, 0.2], [10, 50, 0.3], [5, 200, 0.02]]) assert.ok(Math.abs(binomCdf(k, n, p) - direct(k, n, p)) < 1e-10);
  assert.equal(binomCdf(-1, 10, 0.1), 0);
  assert.equal(binomCdf(10, 10, 0.1), 1);
  assert.ok(binomCdf(500, 100_000, 0.02) < 1e-300 || binomCdf(500, 100_000, 0.02) === 0);
});

test('wilson interval brackets the estimate', () => {
  const [lo, hi] = wilson(98, 100);
  assert.ok(lo > 0.92 && lo < 0.95 && hi > 0.99 && hi <= 1);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('minimum calibration size for an error-free certificate', () => {
  assert.equal(minCalibration(0.02, 0.05), 149);
  assert.equal(minCalibration(0.05, 0.05), 59);
});

test('the local guarantee starts testing where one stray error cannot end it', () => {
  for (const [alpha, delta] of [[0.02, 0.05], [0.04, 0.05], [0.05, 0.1]]) {
    const m = localStart(alpha, delta);
    assert.ok(m >= minCalibration(alpha, delta));
    assert.ok(binomCdf(Math.floor((m * alpha) / 2), m, alpha) <= delta);
    assert.ok(binomCdf(Math.floor(((m - 1) * alpha) / 2), m - 1, alpha) > delta);
  }
  // Clean scores, except that the single most confident row is mislabelled.
  const n = 3000, rand = rng(5), score = new Float64Array(n), wrong = new Uint8Array(n);
  for (let i = 0; i < n; i++) { score[i] = rand(); wrong[i] = score[i] < 0.4 && rand() < 0.3 ? 1 : 0; }
  wrong[score.indexOf(Math.max(...score))] = 1;
  const grid = Array.from({ length: 201 }, (_, i) => i / 200);
  const { cutoff, local } = certify(score, wrong, grid, { alpha: 0.04, delta: 0.05, guarantee: 'local' });
  assert.ok(Number.isFinite(cutoff) && local / n > 0.4, `cutoff ${cutoff}, local ${local}`);
});

test('local certificates keep the error rate on local answers under alpha at least 1 − delta of the time', () => {
  // score ~ U(0,1); P(wrong | s) = 0.2·(1 − s); error rate among answers with score ≥ τ is 0.1·(1 − τ).
  const alpha = 0.04, delta = 0.05, trials = 300, n = 3000;
  const grid = Array.from({ length: 201 }, (_, i) => i / 200);
  const rand = rng(17);
  let violations = 0;
  for (let t = 0; t < trials; t++) {
    const score = new Float64Array(n), wrong = new Uint8Array(n);
    for (let i = 0; i < n; i++) { score[i] = rand(); wrong[i] = rand() < 0.2 * (1 - score[i]) ? 1 : 0; }
    const { cutoff } = certify(score, wrong, grid, { alpha, delta, guarantee: 'local' });
    if (Number.isFinite(cutoff) && 0.1 * (1 - Math.min(1, cutoff)) > alpha) violations++;
  }
  assert.ok(violations / trials <= delta + 0.02, `violation rate ${violations / trials}`);
});

test('certified cutoffs keep the true risk under alpha at least 1 − delta of the time', () => {
  // score ~ U(0,1); P(wrong | score s) = 0.2·(1 − s); true risk(τ) = P(score ≥ τ ∧ wrong) = 0.1·(1 − τ)².
  const alpha = 0.02, delta = 0.05, trials = 400, n = 1500;
  const grid = Array.from({ length: 201 }, (_, i) => i / 200);
  const rand = rng(11);
  let violations = 0, cutoffs = 0;
  for (let t = 0; t < trials; t++) {
    const score = new Float64Array(n), wrong = new Uint8Array(n);
    for (let i = 0; i < n; i++) { score[i] = rand(); wrong[i] = rand() < 0.2 * (1 - score[i]) ? 1 : 0; }
    const { cutoff } = certify(score, wrong, grid, { alpha, delta });
    const risk = Number.isFinite(cutoff) ? 0.1 * (1 - Math.min(1, cutoff)) ** 2 : 0;
    if (risk > alpha) violations++;
    cutoffs += cutoff;
  }
  assert.ok(violations / trials <= delta + 0.02, `violation rate ${violations / trials}`);
  const mean = cutoffs / trials;
  assert.ok(mean > 0.55 && mean < 0.72, `mean cutoff ${mean} should sit just above the oracle 0.553`);
});

test('local guarantee certifies precision on the answered slice', () => {
  const n = 3000, rand = rng(5);
  const score = new Float64Array(n), wrong = new Uint8Array(n);
  for (let i = 0; i < n; i++) { score[i] = rand(); wrong[i] = rand() < 0.3 * (1 - score[i]) ? 1 : 0; }
  const grid = Array.from({ length: 101 }, (_, i) => i / 100);
  const c = certify(score, wrong, grid, { alpha: 0.05, delta: 0.05, guarantee: 'local' });
  assert.ok(Number.isFinite(c.cutoff) && c.local > 0);
  assert.ok(c.errors / c.local < 0.05);
});
