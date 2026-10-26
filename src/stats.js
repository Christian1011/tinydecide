// Binomial tails, Wilson intervals, and Learn-Then-Test cutoff certification.

/** log P(X ≤ k) for X ~ Binomial(n, p), stable for large n. */
export function logBinomCdf(k, n, p) {
  if (k < 0) return -Infinity;
  if (k >= n || p <= 0) return 0;
  if (p >= 1) return -Infinity;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let term = n * lq, acc = term;
  for (let i = 0; i < k; i++) {
    term += Math.log((n - i) / (i + 1)) + lp - lq;
    acc = acc > term ? acc + Math.log1p(Math.exp(term - acc)) : term + Math.log1p(Math.exp(acc - term));
  }
  return Math.min(0, acc);
}

export function binomCdf(k, n, p) { return Math.exp(logBinomCdf(k, n, p)); }

/** Wilson score interval for x successes in n trials. */
export function wilson(x, n, z = 1.959963984540054) {
  if (n === 0) return [0, 1];
  const ph = x / n, z2 = z * z, den = 1 + z2 / n;
  const mid = (ph + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((ph * (1 - ph)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/**
 * Learn-Then-Test with fixed-sequence testing (Angelopoulos et al., 2021).
 * Walks the cutoffs from strictest to loosest and keeps the loosest one whose risk is certified ≤ alpha
 * at level delta; it stops at the first cutoff that fails. The grid must not be chosen from the
 * calibration rows themselves.
 *
 *   guarantee 'overall': risk = P(answered locally and wrong)   (n: all calibration rows)
 *   guarantee 'local'  : risk = P(wrong | answered locally)     (n: rows answered locally)
 *
 * @param {Float64Array|number[]} score  per calibration row; answered locally when score ≥ cutoff
 * @param {Uint8Array|boolean[]} wrong   per calibration row; the local answer differs from the API's
 * @param {number[]} grid                candidate cutoffs, any order
 * @returns {{ cutoff: number, local: number, errors: number, pValue: number, tested: number }}
 */
export function certify(score, wrong, grid, { alpha, delta = 0.05, guarantee = 'overall' }) {
  const n = score.length;
  const order = Array.from(score.keys()).sort((i, j) => score[j] - score[i]);
  const cuts = [...new Set(grid)].sort((a, b) => b - a);
  // For the local guarantee, testing starts at the first cutoff that answers localStart() rows:
  // starting at the bare minimum fails the whole sequence on a single mislabelled row among the most
  // confident few. Which cutoffs are skipped depends only on the scores, never on the errors, so the
  // test sequence is still fixed given the scores.
  const floor = guarantee === 'local' ? localStart(alpha, delta) : 1;
  let best = { cutoff: Infinity, local: 0, errors: 0, pValue: 0, tested: 0 };
  let i = 0, local = 0, errors = 0;
  for (let c = 0; c < cuts.length; c++) {
    const cut = cuts[c];
    while (i < n && score[order[i]] >= cut) { local++; errors += wrong[order[i]] ? 1 : 0; i++; }
    const trials = guarantee === 'local' ? local : n;
    if (trials < floor) continue;
    const pValue = binomCdf(errors, trials, alpha);
    if (pValue > delta) return { ...best, tested: c + 1 };
    best = { cutoff: cut, local, errors, pValue, tested: c + 1 };
  }
  return best;
}

/**
 * Local answers needed before the local guarantee starts testing: the smallest sample on which an
 * error rate of half the budget would still certify, so one stray label error cannot end the test.
 */
export function localStart(alpha, delta = 0.05) {
  let m = minCalibration(alpha, delta);
  while (binomCdf(Math.floor((m * alpha) / 2), m, alpha) > delta) m++;
  return m;
}

/** Smallest calibration size at which an error-free sample can certify alpha at level delta. */
export function minCalibration(alpha, delta = 0.05) {
  return Math.ceil(Math.log(delta) / Math.log1p(-alpha));
}
