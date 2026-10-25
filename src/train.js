// fastText-style trainer: mean-pooled hashed features → linear head, plain SGD with linear decay,
// distilling your API's soft labels (one-hot when it gives only a label).

import { U32Map, rng } from './hash.js';

export const RECIPE = Object.freeze({ d: 32, lr: 0.5, minCount: 2, maxFeatures: 200_000, steps: 200_000, minEpochs: 5, maxEpochs: 25 });

export const tick = makeTick();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Yield to the event loop between chunks of work. Browsers clamp nested setTimeout to 4 ms, so use a
// MessageChannel there; Node has setImmediate.
function makeTick() {
  if (typeof setImmediate === 'function') return () => new Promise((r) => setImmediate(r));
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel(), queue = [];
    ch.port1.onmessage = () => queue.shift()?.();
    return () => new Promise((r) => { queue.push(r); ch.port2.postMessage(0); });
  }
  return () => new Promise((r) => setTimeout(r, 0));
}

/**
 * @param {{ w: Uint32Array, c: Uint32Array, t: Float32Array }[]} rows  features and target distribution
 * @param {number} K
 * @returns {Promise<{ d, keys: Uint32Array, E: Float32Array, W: Float32Array, b: Float32Array, epochs: number }>}
 */
export async function train(rows, K, opts = {}) {
  const { d, lr, minCount, maxFeatures, steps, minEpochs, maxEpochs } = { ...RECIPE, ...opts };
  const seed = opts.seed ?? 1;
  const onProgress = opts.onProgress ?? (() => {});
  const yieldMs = opts.yieldMs ?? 30;

  // Vocabulary: features seen at least minCount times, the most frequent maxFeatures of them.
  const counts = new U32Map(1 << 16);
  for (const r of rows) { for (const f of r.w) counts.inc(f); for (const f of r.c) counts.inc(f); }
  let kept = [];
  counts.forEach((key, n) => { if (n >= minCount) kept.push([key, n]); });
  if (kept.length > maxFeatures) kept = kept.sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, maxFeatures);
  const keys = Uint32Array.from(kept.map((e) => e[0])).sort();
  const index = new U32Map(keys.length);
  for (let i = 0; i < keys.length; i++) index.set(keys[i], i);
  const ids = (feats) => {
    const out = [];
    for (const f of feats) { const r = index.get(f); if (r >= 0) out.push(r); }
    return Int32Array.from(out);
  };
  const data = rows.map((r) => ({ w: ids(r.w), c: ids(r.c), t: r.t }));

  const V = keys.length;
  const E = new Float32Array(V * d);
  const W = new Float32Array(K * d);
  const b = new Float32Array(K);
  const rand = rng(seed);
  const a = Math.sqrt(6 / (d + K));
  for (let i = 0; i < W.length; i++) W[i] = (rand() * 2 - 1) * a;
  // Start the bias at the API's average distribution.
  const prior = new Float64Array(K);
  for (const r of data) for (let k = 0; k < K; k++) prior[k] += r.t[k];
  for (let k = 0; k < K; k++) b[k] = Math.log((prior[k] + 1) / (data.length + K));

  const N = data.length;
  const epochs = Math.max(minEpochs, Math.min(maxEpochs, Math.round(steps / Math.max(1, N))));
  const total = epochs * N;
  const h = new Float32Array(d), hw = new Float32Array(d), hc = new Float32Array(d), gh = new Float32Array(d);
  const p = new Float32Array(K);
  const order = Int32Array.from({ length: N }, (_, i) => i);
  let step = 0, last = now();

  for (let ep = 0; ep < epochs; ep++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const x = order[i]; order[i] = order[j]; order[j] = x; }
    for (let s = 0; s < N; s++, step++) {
      const ex = data[order[s]];
      const rate = lr * (1 - step / total);
      const nw = ex.w.length, nc = ex.c.length;
      if (nw + nc === 0) continue;
      meanInto(hw, E, ex.w, d); meanInto(hc, E, ex.c, d);
      for (let j = 0; j < d; j++) h[j] = hw[j] + hc[j];
      let m = -Infinity;
      for (let k = 0; k < K; k++) {
        let z = b[k];
        const o = k * d;
        for (let j = 0; j < d; j++) z += W[o + j] * h[j];
        p[k] = z; if (z > m) m = z;
      }
      let sum = 0;
      for (let k = 0; k < K; k++) sum += p[k] = Math.exp(p[k] - m);
      gh.fill(0);
      for (let k = 0; k < K; k++) {
        const g = p[k] / sum - ex.t[k];
        if (g === 0) continue;
        const o = k * d;
        for (let j = 0; j < d; j++) { gh[j] += W[o + j] * g; W[o + j] -= rate * g * h[j]; }
        b[k] -= rate * g;
      }
      if (nw) scatter(E, ex.w, gh, -rate / nw, d);
      if (nc) scatter(E, ex.c, gh, -rate / nc, d);
      if ((step & 255) === 0 && now() - last > yieldMs) {
        onProgress({ phase: 'train', done: step / total });
        await tick();
        if (opts.signal?.aborted) throw abortError();
        last = now();
      }
    }
  }
  onProgress({ phase: 'train', done: 1 });
  return { d, keys, E, W, b, epochs };
}

function meanInto(out, E, ids, d) {
  out.fill(0);
  const n = ids.length;
  if (!n) return;
  for (let i = 0; i < n; i++) { const o = ids[i] * d; for (let j = 0; j < d; j++) out[j] += E[o + j]; }
  for (let j = 0; j < d; j++) out[j] /= n;
}

function scatter(E, ids, g, scale, d) {
  for (let i = 0; i < ids.length; i++) { const o = ids[i] * d; for (let j = 0; j < d; j++) E[o + j] += scale * g[j]; }
}

export function abortError() {
  const err = new Error('compile aborted');
  err.name = 'AbortError';
  return err;
}
