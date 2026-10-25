import { rng } from '../src/hash.js';

// A labelled toy stream: each label owns a few cue words; texts without a cue get an arbitrary
// API answer, so a good compile must learn the cues and defer the rest.
export function toyTraffic(n, { seed = 7, labels = ['billing', 'bug', 'login', 'other'], noise = 0.15, policy } = {}) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const cues = Object.fromEntries(labels.map((l, i) => [l, Array.from({ length: 12 }, (_, j) => `${l}${'xyzw'[j % 4]}${j}${i}`)]));
  const filler = Array.from({ length: 300 }, (_, i) => `w${i}`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const words = Array.from({ length: 6 + Math.floor(rand() * 8) }, () => pick(filler));
    let choice;
    if (rand() < noise) choice = pick(labels);
    else { choice = pick(labels); words.splice(Math.floor(rand() * words.length), 0, pick(cues[choice]), pick(cues[choice])); }
    if (policy) choice = policy(choice);
    out.push({ input: words.join(' '), choice });
  }
  return out;
}
