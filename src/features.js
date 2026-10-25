// Text → hashed features. Two groups are kept apart because they pool separately in the model:
//   words: word unigrams, word bigrams, number shapes, and (for pairs) side + overlap features
//   chars: character 2–4 grams inside each word, with < > word boundaries
// Han and kana characters are tokens of their own, so CJK text gets character unigrams and bigrams.

import { fmix, hashString } from './hash.js';

export const FEATURES_VERSION = 1;

const TOKEN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu;
const DIGITS = /^\p{Nd}+$/u;
const MAX_CHARS = 4000;
const MAX_TOKENS = 400;
const MAX_GRAM_TOKEN = 48;
const MIN_N = 2;
const MAX_N = 4;

const SEED = {
  word: 0x1b873593, bigram: 0xcc9e2d51, char: 0x85ebca77, shape: 0x27d4eb2f,
  sideA: 0x165667b1, sideB: 0xd3a2646c, shared: 0xfd7046c5, onlyA: 0xb55a4f09, onlyB: 0x6c8e9cf5, jaccard: 0x9e3779b1,
};

/** Normalizes any supported input into { text } or { a, b }. */
export function asInput(input) {
  if (typeof input === 'string') return { text: input };
  if (input == null) return { text: '' };
  if (typeof input === 'object') {
    if (typeof input.a === 'string' && typeof input.b === 'string') return { a: input.a, b: input.b };
    for (const k of ['state', 'text', 'input', 'content', 'message']) if (typeof input[k] === 'string') return { text: input[k] };
  }
  return { text: stableString(input) };
}

/** A canonical text for an input, used for grouping and de-duplication. */
export function inputKey(input) {
  const x = asInput(input);
  return x.text !== undefined ? normalize(x.text) : normalize(x.a) + '␞' + normalize(x.b);
}

export function normalize(s) {
  return String(s).slice(0, MAX_CHARS).normalize('NFKC').toLowerCase();
}

function tokens(text) {
  const out = [];
  for (const m of normalize(text).matchAll(TOKEN)) {
    out.push(m[0]);
    if (out.length === MAX_TOKENS) break;
  }
  return out;
}

/** Growable uint32 buffer, reused across calls so the hot path does not allocate per feature. */
class Buf {
  constructor(n = 256) { this.a = new Uint32Array(n); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  view() { return this.a.subarray(0, this.n); }
}

export class Featurizer {
  constructor() { this.w = new Buf(); this.c = new Buf(); }

  /** Returns { w, c } views into internal buffers; copy them if you keep them past the next call. */
  run(input) {
    const x = asInput(input);
    this.w.n = 0; this.c.n = 0;
    if (x.text !== undefined) {
      this.#side(tokens(x.text), 0);
    } else {
      const ta = tokens(x.a), tb = tokens(x.b);
      const ua = this.#side(ta, SEED.sideA), ub = this.#side(tb, SEED.sideB);
      let shared = 0;
      for (const h of ub) {
        const inA = ua.has(h);
        if (inA) shared++;
        this.w.push(fmix(h ^ (inA ? SEED.shared : SEED.onlyB)));
      }
      for (const h of ua) if (!ub.has(h)) this.w.push(fmix(h ^ SEED.onlyA));
      const union = ua.size + ub.size - shared;
      const bucket = union ? Math.round((10 * shared) / union) : 10;
      for (let i = 0; i < 4; i++) this.w.push(fmix(SEED.jaccard + bucket * 16 + i));
    }
    return { w: this.w.view(), c: this.c.view() };
  }

  /** Copies of the features for one input, safe to store. */
  copy(input) {
    const { w, c } = this.run(input);
    return { w: w.slice(), c: c.slice() };
  }

  #side(toks, salt) {
    const uni = new Set();
    let prev = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const h = hashString(t, SEED.word);
      uni.add(h);
      this.w.push(salt ? fmix(h ^ salt) : h);
      if (i > 0) this.w.push(fmix((Math.imul(prev, 0x9e3779b1) ^ h ^ SEED.bigram ^ salt) >>> 0));
      prev = h;
      if (DIGITS.test(t)) this.w.push(fmix(SEED.shape + Math.min(t.length, 12) * 31 + salt));
      if (t.length > 1) this.#grams(t, salt);
    }
    return uni;
  }

  #grams(t, salt) {
    const len = Math.min(t.length, MAX_GRAM_TOKEN) + 2;
    const code = (j) => (j === 0 ? 60 : j === len - 1 ? 62 : t.charCodeAt(j - 1));
    for (let i = 0; i < len - 1; i++) {
      let h = SEED.char ^ salt;
      for (let j = i, n = 1; j < len && n <= MAX_N; j++, n++) {
        h = Math.imul(h ^ code(j), 0x01000193);
        if (n >= MIN_N) this.c.push(fmix((h + n) >>> 0));
      }
    }
  }
}

function stableString(v) {
  if (v === null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(stableString).join(' ');
  return Object.keys(v).sort().map((k) => `${k}: ${stableString(v[k])}`).join('\n');
}
