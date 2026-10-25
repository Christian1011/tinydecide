// compile(): your API's answers in, a certified local model and an honest report out.
//
//   1. Split rows into train / calib / test by group (or by normalized text), so repeats never leak.
//   2. Train on train, quantize to int8. Every later number is measured on the int8 model you ship.
//   3. On calib, certify the loosest margin cutoff that keeps agreement with the API ≥ target,
//      with probability ≥ 1 − delta over the draw of calibration rows (Learn-Then-Test).
//   4. On test, report what that cutoff actually did, with Wilson intervals.

import { Featurizer, inputKey } from './features.js';
import { hashString } from './hash.js';
import { Model, quantize, softmax, topTwo } from './model.js';
import { certify, localStart, minCalibration, wilson } from './stats.js';
import { RECIPE, abortError, tick, train } from './train.js';

export const DEFAULTS = Object.freeze({ target: 0.98, delta: 0.05, guarantee: 'overall', calib: 0.25, test: 0.1, seed: 1, audit: 0.02 });

// Cutoffs on the logit margin. Fixed in advance, as Learn-Then-Test requires.
const GRID = [0, ...Array.from({ length: 600 }, (_, i) => 0.01 * 6000 ** (i / 599))];
const WHAT_IF = [0.9, 0.95, 0.97, 0.98, 0.99, 0.995];
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {Iterable<object>} records  { input, choice?, probs?, group? } — see README for accepted shapes
 * @param {object} [opts]
 * @returns {Promise<{ model: Model, report: object }>}
 */
export async function compile(records, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const alpha = 1 - o.target;
  const t0 = now();
  const onProgress = o.onProgress ?? (() => {});
  const pause = async () => { await tick(); if (o.signal?.aborted) throw abortError(); };

  const { labels, rows, skipped } = readRecords(records, o.labels);
  const K = labels.length;
  if (K < 2) throw new Error(`need at least two labels, saw ${K}`);

  const split = { train: [], calib: [], test: [] };
  const salt = 0x7f4a7c15 ^ o.seed;
  for (const r of rows) {
    const u = (hashString(r.group, salt) % 100_000) / 100_000;
    const part = u < o.test ? 'test' : u < o.test + o.calib ? 'calib' : 'train';
    if (r.trainOnly && part !== 'train') continue; // not an iid draw of traffic, so never certify on it
    split[part].push(r);
  }
  if (split.train.length < 2 * K) throw new Error(`only ${split.train.length} training rows for ${K} labels`);

  onProgress({ phase: 'features', done: 0 });
  const fz = new Featurizer();
  const trainRows = [];
  for (const r of split.train) {
    trainRows.push({ ...fz.copy(r.input), t: r.t });
    if (trainRows.length % 2000 === 0) await pause();
  }
  const params = await train(trainRows, K, { ...pick(o, Object.keys(RECIPE)), seed: o.seed, onProgress, yieldMs: o.yieldMs, signal: o.signal });
  const trainMs = now() - t0;

  await pause();
  const draft = quantize({ labels, ...params });
  const cal = score(draft, split.calib);
  await pause();
  const T = fitTemperature(cal);
  await pause();
  const cert = certify(cal.margin, cal.wrong, GRID, { alpha, delta: o.delta, guarantee: o.guarantee });
  const whatIf = WHAT_IF.map((target) => {
    const c = certify(cal.margin, cal.wrong, GRID, { alpha: 1 - target, delta: o.delta, guarantee: o.guarantee });
    return { target, share: cal.n ? c.local / cal.n : 0 };
  });

  const certificate = {
    target: o.target, delta: o.delta, guarantee: o.guarantee, n: cal.n,
    local: cert.local, errors: cert.errors, pValue: cert.pValue, cutoff: cert.cutoff,
  };
  const calShare = cal.n ? cert.local / cal.n : 0;
  const calLocalAgree = cert.local ? 1 - cert.errors / cert.local : null;
  // How often the model's guess matches the API on calls it defers. shadow() watches this live:
  // deferred calls get the API's answer anyway, so a drop here is a free early sign of drift.
  // Per label the model leans toward, how its confidence on deferred calls compares with how often
  // the API actually agreed: shadow() expects that ratio live. Shrunk toward 1 when rows are few.
  let dn = 0, dAgree = 0;
  const seen = new Float64Array(K), expected = new Float64Array(K);
  for (let i = 0; i < cal.n; i++) {
    if (cal.margin[i] >= cert.cutoff) continue;
    dn++;
    if (!cal.wrong[i]) dAgree++;
    const p = softmax(cal.Z[i], T), top = topTwo(cal.Z[i]).top;
    expected[top] += p[top];
    seen[top] += cal.wrong[i] ? 0 : 1;
  }
  const SHRINK = 10;
  const ratio = Object.fromEntries(labels.map((l, k) => [l, Math.round(((seen[k] + SHRINK) / (expected[k] + SHRINK)) * 1000) / 1000]));
  const meta = {
    created: new Date().toISOString(), certificate, rows: { total: rows.length, train: split.train.length, calib: cal.n, test: split.test.length },
    expected: { share: calShare, localAgreement: calLocalAgree, deferred: { n: dn, agreement: dn ? dAgree / dn : null, ratio } }, audit: o.audit,
  };
  const model = new Model({ ...draft, T, cutoff: cert.cutoff, meta });

  await pause();
  const test = split.test.length ? evaluate(model, split.test, params) : null;
  await pause();
  const latencyUs = timeDecide(model, (split.test.length ? split.test : split.calib).slice(0, 400));

  const share = test ? test.share : calShare;
  const minCal = o.guarantee === 'local' ? localStart(alpha, o.delta) : minCalibration(alpha, o.delta);
  const verdict =
    cal.n < minCal ? 'need-more-data' : calShare >= 0.25 ? 'ship' : calShare >= 0.05 ? 'marginal' : 'not-worth-it';
  const report = {
    verdict,
    summary: summarize({ verdict, o, calShare, cal, minCal, whatIf }),
    labels, target: o.target, delta: o.delta, guarantee: o.guarantee,
    rows: { ...meta.rows, skipped },
    features: params.keys.length, epochs: params.epochs,
    certificate,
    calib: { share: calShare, localAgreement: calLocalAgree, overallAgreement: cal.n ? 1 - cert.errors / cal.n : null, rawAgreement: cal.n ? 1 - cal.errors / cal.n : null },
    test,
    whatIf,
    savings: { apiCallsAvoided: share * (1 - o.audit), auditRate: o.audit },
    temperature: T,
    bytes: model.toBytes().byteLength,
    latencyUs,
    ms: { train: Math.round(trainMs), total: Math.round(now() - t0) },
  };
  model.meta.verdict = verdict;
  onProgress({ phase: 'done', done: 1 });
  return { model, report };
}

/** Normalizes answer records into { input, group, choice, t }. */
export function readRecords(records, given) {
  const list = Array.isArray(records) ? records : [...records];
  let labels = given ? [...given] : null;
  if (!labels) {
    const seen = new Set();
    let fileLabels = null;
    for (const r of list) {
      if (Array.isArray(r.labels)) fileLabels ??= r.labels;
      const c = choiceOf(r, null);
      if (typeof c === 'string') seen.add(c);
      if (r.probs && !Array.isArray(r.probs)) for (const k of Object.keys(r.probs)) seen.add(k);
    }
    labels = fileLabels ?? [...seen].sort();
  }
  const at = new Map(labels.map((l, i) => [l, i]));
  const K = labels.length;
  const rows = [];
  let skipped = 0;
  for (const r of list) {
    if (r.labels && !r.input && !('choice' in r) && !r.probs) continue; // a header line
    const input = inputOf(r);
    let t = null;
    if (r.probs) {
      t = new Float32Array(K);
      if (Array.isArray(r.probs)) { if (r.probs.length !== K) { skipped++; continue; } r.probs.forEach((p, k) => (t[k] = Math.max(0, +p || 0))); }
      else for (const [l, p] of Object.entries(r.probs)) { const k = at.get(l); if (k !== undefined) t[k] = Math.max(0, +p || 0); }
      const s = t.reduce((a, b) => a + b, 0);
      if (!(s > 0)) t = null; else for (let k = 0; k < K; k++) t[k] /= s;
    }
    let c = choiceOf(r, labels);
    let y = typeof c === 'string' ? at.get(c) : undefined;
    if (y === undefined && t) y = argmax(t);
    if (y === undefined || input === undefined) { skipped++; continue; }
    if (!t) { t = new Float32Array(K); t[y] = 1; }
    rows.push({ input, group: r.group != null ? String(r.group) : inputKey(input), y, t, trainOnly: r.sample === false });
  }
  return { labels, rows, skipped };
}

function inputOf(r) {
  if (r.input !== undefined) return r.input;
  if (typeof r.a === 'string' && typeof r.b === 'string') return { a: r.a, b: r.b };
  for (const k of ['text', 'state', 'content', 'message']) if (typeof r[k] === 'string') return r[k];
  return undefined;
}

function choiceOf(r, labels) {
  let c = r.choice ?? r.label ?? r.decision ?? r.answer;
  if (c && typeof c === 'object') c = c.choice ?? c.label;
  if (typeof c === 'number' && labels) c = labels[c];
  return c;
}

function argmax(a) {
  let m = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[m]) m = i;
  return m;
}

function score(model, rows) {
  const n = rows.length;
  const margin = new Float64Array(n), wrong = new Uint8Array(n), Z = [], y = new Int32Array(n);
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const z = model.logits(rows[i].input);
    const { top, second } = topTwo(z);
    margin[i] = second < 0 ? Infinity : z[top] - z[second];
    wrong[i] = top !== rows[i].y ? 1 : 0;
    errors += wrong[i];
    Z.push(Float32Array.from(z));
    y[i] = rows[i].y;
  }
  return { n, margin, wrong, Z, y, errors };
}

/** Temperature that best explains the API's choices on calib. Only reported confidence uses it. */
function fitTemperature({ Z, y, n }) {
  if (!n) return 1;
  const nll = (T) => {
    let s = 0;
    for (let i = 0; i < n; i++) s -= Math.log(Math.max(softmax(Z[i], T)[y[i]], 1e-12));
    return s / n;
  };
  let lo = Math.log(0.05), hi = Math.log(20);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo), b = lo + g * (hi - lo), fa = nll(Math.exp(a)), fb = nll(Math.exp(b));
  for (let it = 0; it < 40; it++) {
    if (fa < fb) { hi = b; b = a; fb = fa; a = hi - g * (hi - lo); fa = nll(Math.exp(a)); }
    else { lo = a; a = b; fa = fb; b = lo + g * (hi - lo); fb = nll(Math.exp(b)); }
  }
  return Math.exp((lo + hi) / 2);
}

function evaluate(model, rows, params) {
  const n = rows.length;
  const float = new Model({ ...model, q: params.E, scales: new Float32Array(params.keys.length).fill(1) });
  let local = 0, localWrong = 0, rawWrong = 0, flips = 0;
  for (const r of rows) {
    const d = model.decide(r.input);
    if (d.index !== r.y) rawWrong++;
    if (d.local) { local++; if (d.index !== r.y) localWrong++; }
    if (topTwo(float.logits(r.input)).top !== d.index) flips++;
  }
  return {
    n, share: local / n,
    overallAgreement: 1 - localWrong / n, overallCI: wilson(n - localWrong, n),
    localAgreement: local ? 1 - localWrong / local : null, localCI: local ? wilson(local - localWrong, local) : null,
    rawAgreement: 1 - rawWrong / n, int8Flips: flips,
  };
}

function timeDecide(model, rows) {
  if (!rows.length) return null;
  for (const r of rows) model.decide(r.input);
  const t = now();
  let reps = 0;
  while (now() - t < 50) { for (const r of rows) model.decide(r.input); reps++; }
  return Math.round(((now() - t) * 1000) / (reps * rows.length) * 10) / 10;
}

function summarize({ verdict, o, calShare, cal, minCal, whatIf }) {
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  const scope = o.guarantee === 'local' ? 'agreement on the answers it gives' : 'overall agreement with your API';
  if (verdict === 'need-more-data') return `Only ${cal.n} calibration rows; certifying ${pct(o.target)} needs at least ${minCal}. Keep shadowing and compile again.`;
  const head = `Answers ${pct(calShare)} of calls locally while keeping ${scope} ≥ ${pct(o.target)} (${pct(1 - o.delta)} confidence).`;
  if (verdict === 'ship') return head;
  const looser = whatIf.filter((w) => w.target < o.target && w.share >= Math.max(0.25, calShare * 2)).at(-1);
  const hint = looser ? ` At ${pct(looser.target)} it would answer ${pct(looser.share)}.` : '';
  if (verdict === 'marginal') return `${head} Savings are small.${hint}`;
  return `Not worth it: only ${pct(calShare)} of calls clear the cutoff. A word-level model can't copy this decision reliably; keep calling the API.${hint}`;
}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

