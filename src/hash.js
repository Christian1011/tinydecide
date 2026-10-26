// 32-bit hashing shared by the featurizer, the trainer and the runtime. Everything is integer math on
// UTF-16 code units, so a feature hashes identically in every JS engine.

export const FNV_OFFSET = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

/** Murmur3 finalizer: spreads the bits of an FNV state so low bits are usable as table indexes. */
export function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over a string, seeded. */
export function hashString(s, seed = FNV_OFFSET) {
  let h = seed;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return fmix(h);
}

/** Deterministic PRNG (mulberry32) so compiles are reproducible from a seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Open-addressing map from uint32 keys to int32 values (-1 = absent). Keys are already well mixed. */
export class U32Map {
  constructor(capacity = 1024) {
    let cap = 16;
    while (cap < capacity * 2) cap <<= 1;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap);
    this.vals = new Int32Array(cap).fill(-1);
    this.size = 0;
  }

  get(key) {
    const { keys, vals, mask } = this;
    for (let i = key & mask; ; i = (i + 1) & mask) {
      const v = vals[i];
      if (v === -1) return -1;
      if (keys[i] === key) return v;
    }
  }

  set(key, val) {
    if ((this.size + 1) * 2 > this.mask + 1) this.#grow();
    const { keys, vals, mask } = this;
    for (let i = key & mask; ; i = (i + 1) & mask) {
      if (vals[i] === -1) { keys[i] = key; vals[i] = val; this.size++; return; }
      if (keys[i] === key) { vals[i] = val; return; }
    }
  }

  /** Adds 1 to the value at key (absent counts as 0); returns the new count. */
  inc(key) {
    if ((this.size + 1) * 2 > this.mask + 1) this.#grow();
    const { keys, vals, mask } = this;
    for (let i = key & mask; ; i = (i + 1) & mask) {
      if (vals[i] === -1) { keys[i] = key; vals[i] = 1; this.size++; return 1; }
      if (keys[i] === key) return ++vals[i];
    }
  }

  forEach(fn) {
    const { keys, vals } = this;
    for (let i = 0; i < vals.length; i++) if (vals[i] !== -1) fn(keys[i], vals[i]);
  }

  #grow() {
    const { keys, vals } = this;
    const cap = (this.mask + 1) * 2;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap);
    this.vals = new Int32Array(cap).fill(-1);
    this.size = 0;
    for (let i = 0; i < vals.length; i++) if (vals[i] !== -1) this.set(keys[i], vals[i]);
  }
}
