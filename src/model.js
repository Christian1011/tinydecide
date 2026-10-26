// The compiled model: hashed feature rows (int8, one scale per row) → two mean pools → linear head.
// A .tdm file is: "TDM1", u32 header length, JSON header (padded to 4 bytes), then the arrays.

import { FEATURES_VERSION, Featurizer } from './features.js';
import { U32Map } from './hash.js';

const MAGIC = [0x54, 0x44, 0x4d, 0x31]; // TDM1

export class Model {
  /**
   * @param {object} p
   * @param {string[]} p.labels
   * @param {number} p.d            row width
   * @param {Uint32Array} p.keys    feature hash per row
   * @param {Float32Array} p.scales per-row dequantization scale
   * @param {Int8Array} p.q         rows, keys.length × d
   * @param {Float32Array} p.W      head, labels.length × d
   * @param {Float32Array} p.b      bias, labels.length
   * @param {number} [p.T]          temperature for reported confidence
   * @param {number} [p.cutoff]     answer locally when the top-two logit margin ≥ cutoff
   * @param {object} [p.meta]       certificate and compile report summary
   */
  constructor({ labels, d, keys, scales, q, W, b, T = 1, cutoff = Infinity, meta = {} }) {
    Object.assign(this, { labels, d, keys, scales, q, W, b, T, cutoff, meta });
    this.K = labels.length;
    this.index = new U32Map(keys.length);
    for (let i = 0; i < keys.length; i++) this.index.set(keys[i], i);
    this.fz = new Featurizer();
    this.h = new Float32Array(d);
    this.tmp = new Float32Array(d);
    this.z = new Float32Array(this.K);
  }

  /** Raw logits for an input. The returned array is reused by the next call. */
  logits(input) {
    const { w, c } = this.fz.run(input);
    const { d, K, h, z, W, b } = this;
    h.fill(0);
    this.#pool(w); this.#pool(c);
    for (let k = 0; k < K; k++) {
      let s = b[k];
      const o = k * d;
      for (let j = 0; j < d; j++) s += W[o + j] * h[j];
      z[k] = s;
    }
    return z;
  }

  #pool(feats) {
    const { d, index, q, scales, h, tmp } = this;
    tmp.fill(0);
    let n = 0;
    for (let i = 0; i < feats.length; i++) {
      const r = index.get(feats[i]);
      if (r < 0) continue;
      n++;
      const s = scales[r], o = r * d;
      for (let j = 0; j < d; j++) tmp[j] += q[o + j] * s;
    }
    if (n) for (let j = 0; j < d; j++) h[j] += tmp[j] / n;
  }

  /**
   * @returns {{ choice: string, index: number, confidence: number, margin: number, local: boolean, probs?: Record<string, number> }}
   */
  decide(input, { probs = false } = {}) {
    const z = this.logits(input);
    const { top, second } = topTwo(z);
    const margin = second < 0 ? Infinity : z[top] - z[second];
    const p = softmax(z, this.T);
    const out = { choice: this.labels[top], index: top, confidence: p[top], margin, local: margin >= this.cutoff };
    if (probs) out.probs = Object.fromEntries(this.labels.map((l, k) => [l, p[k]]));
    return out;
  }

  /** A copy that answers with a different cutoff (e.g. Infinity to send everything to your API). */
  withCutoff(cutoff) {
    return new Model({ ...this, cutoff });
  }

  get bytes() {
    return this.keys.byteLength + this.scales.byteLength + this.q.byteLength + this.W.byteLength + this.b.byteLength;
  }

  toBytes() {
    const header = new TextEncoder().encode(JSON.stringify({
      format: 1, features: FEATURES_VERSION, labels: this.labels, d: this.d, n: this.keys.length,
      T: this.T, cutoff: Number.isFinite(this.cutoff) ? this.cutoff : null, meta: this.meta,
    }));
    const hlen = (header.length + 3) & ~3;
    const parts = [this.keys, this.scales, this.W, this.b, this.q];
    const body = parts.reduce((s, a) => s + a.byteLength, 0);
    const out = new Uint8Array(8 + hlen + body);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint32(4, header.length, true);
    out.set(header, 8);
    out.fill(0x20, 8 + header.length, 8 + hlen);
    let o = 8 + hlen;
    for (const a of parts) { out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o); o += a.byteLength; }
    return out;
  }

  static fromBytes(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (MAGIC.some((m, i) => u8[i] !== m)) throw new Error('not a tinydecide model (bad magic)');
    const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + len)));
    if (h.format !== 1) throw new Error(`unsupported model format ${h.format}`);
    if (h.features !== FEATURES_VERSION) throw new Error(`model needs featurizer v${h.features}, this build has v${FEATURES_VERSION}`);
    const K = h.labels.length;
    // Copy the body into a fresh buffer: typed-array views need alignment, and a Node Buffer's
    // .slice() is a view into a shared pool, not a copy.
    const body = new Uint8Array(u8.byteLength - (8 + ((len + 3) & ~3)));
    body.set(u8.subarray(8 + ((len + 3) & ~3)));
    const buf = body.buffer;
    let o = 0;
    const take = (Ctor, n) => { const a = new Ctor(buf, o, n); o += n * Ctor.BYTES_PER_ELEMENT; return a; };
    const keys = take(Uint32Array, h.n), scales = take(Float32Array, h.n);
    const W = take(Float32Array, K * h.d), b = take(Float32Array, K), q = take(Int8Array, h.n * h.d);
    return new Model({ labels: h.labels, d: h.d, keys, scales, q, W, b, T: h.T, cutoff: h.cutoff ?? Infinity, meta: h.meta });
  }
}

export function topTwo(z) {
  let top = 0, second = -1;
  for (let k = 1; k < z.length; k++) {
    if (z[k] > z[top]) { second = top; top = k; } else if (second < 0 || z[k] > z[second]) second = k;
  }
  return { top, second };
}

export function softmax(z, T = 1) {
  let m = -Infinity;
  for (let k = 0; k < z.length; k++) if (z[k] > m) m = z[k];
  const p = new Float64Array(z.length);
  let s = 0;
  for (let k = 0; k < z.length; k++) s += p[k] = Math.exp((z[k] - m) / T);
  for (let k = 0; k < z.length; k++) p[k] /= s;
  return p;
}

/** Per-row symmetric int8 quantization of float training parameters. */
export function quantize({ labels, d, keys, E, W, b }, extra = {}) {
  const n = keys.length;
  const q = new Int8Array(n * d), scales = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let m = 0;
    for (let j = 0; j < d; j++) m = Math.max(m, Math.abs(E[r * d + j]));
    const s = m / 127 || 1;
    scales[r] = m ? s : 0;
    for (let j = 0; j < d; j++) q[r * d + j] = Math.round(E[r * d + j] / s);
  }
  return new Model({ labels, d, keys, scales, q, W: Float32Array.from(W), b: Float32Array.from(b), ...extra });
}
