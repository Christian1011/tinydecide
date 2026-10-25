// shadow(): wrap a decision API so it keeps working exactly as before, while a local model learns
// from its answers and gradually takes over the calls it can answer within the agreement target.
//
// Modes
//   learning  every call goes to your API; every answer is logged
//   local     confident calls are answered locally, the rest go to your API
//   guarded   a live check failed or a new label appeared; every call goes to your API until a
//             compile on post-incident answers certifies again
//
// A uniform random sample of calls (rate `audit`) is also answered by your API whatever the route.
// That sample is iid over traffic, so it drives both the live agreement check and later calibration;
// calls logged only because they were deferred are used for training, never for certifying.
//
// Two live checks can switch to guarded:
//   audit     a CUSUM test on the random sample finds overall agreement below target: about 2% false
//             alarms over a model's life when agreement sits exactly at target, fewer above it
//   deferred  on deferred calls (answered by your API anyway, so free to check), the model's guess
//             matches your API far less often than it did on calibration, overall or for one label
//             against the model's own calibrated confidence — the fastest sign the API changed
//
// One rule above all: TinyDecide never makes a call fail that would have succeeded without it.
// If anything inside it throws, the call goes to your API.

import { compile } from './compile.js';
import { logger } from './log.js';
import { wilson } from './stats.js';
import { memoryStore } from './store.js';

const GUARD_Z = 3; // strict, because the guard is re-checked on every observation
const CUSUM_ALTS = [2, 4, 8]; // error rates the audit check watches for, as multiples of 1 − target
const CUSUM_H = 9;
const DEFERRED_WINDOW = 400;
const DEFERRED_MIN = 100;
const DEFERRED_SLACK = 0.05;
const LABEL_WINDOW = 200; // deferred calls per label the model leans toward
const LABEL_MIN = 20;
const LABEL_Z = 4; // stricter still: one check per label
const LABEL_SLACK = 0.1; // room for the model's confidence being somewhat off on one label
const LABEL_KEYS = ['choice', 'label', 'decision', 'answer'];
const PROBS_KEYS = ['probs', 'probabilities'];
const OPTIONS = ['target', 'delta', 'audit', 'labels', 'model', 'store', 'choice', 'respond', 'group', 'fallback', 'log', 'onEvent', 'autoCompile', 'compile', 'compiler', 'random'];
const now = () => globalThis.performance?.now() ?? Date.now();

/**
 * @param {string} [name]  names the decision in logs; in Node it also names its folder in .tinydecide/
 * @param {(input: any) => any} api  your existing decision call
 * @param {object} [options]  see README
 */
export function shadow(name, api, options) {
  if (typeof name === 'function') [name, api, options] = [undefined, name, api];
  options ??= {};
  validate(name, api, options);
  const o = {
    target: 0.98, delta: 0.05, audit: 0.02, labels: undefined, model: null, store: null,
    choice: defaultChoice, respond: undefined, group: undefined, fallback: false, log: true,
    onEvent: () => {}, compile: {}, compiler: compile, random: Math.random,
    ...options,
  };
  const auto = o.autoCompile === false ? null : { min: 2000, growth: 2, maxEvery: 20_000, window: 50_000, ...o.autoCompile };
  const store = o.store ?? memoryStore();
  const say = logger(name, o.log);

  let model = null;
  let mode = 'learning';
  let shape = null; // how your API's responses look, so local answers come back the same way
  let incident = null; // { t } while guarded
  let epoch = 0; // bumps on every guard trip; a compile that started in an older epoch is discarded
  let compiling = null;
  let running = null; // AbortController of the compile in flight, so a guard trip can stop it
  let closed = false;
  let unreadable = false;
  // The compile schedule: answers available, answers since the last compile, and rows it used.
  let available = 0, fresh = 0, basis = 0, sinceIncident = 0;
  const ring = new Uint8Array(500); // recent audits, for stats and the guard message
  let ringN = 0, ringAgree = 0, ringAt = 0;
  const alpha = 1 - o.target;
  const steps = CUSUM_ALTS.map((m) => { const p = Math.min(0.5, m * alpha); return [Math.log((1 - p) / (1 - alpha)), Math.log(p / alpha)]; });
  const cusum = CUSUM_ALTS.map(() => 0);
  const dring = new Uint8Array(DEFERRED_WINDOW);
  let dN = 0, dAgree = 0, dAt = 0;
  const byLabel = new Map(); // label the model leans toward → its deferred calls: agreed, and confidence
  const n = { calls: 0, local: 0, api: 0, fallback: 0, audits: 0, auditDisagree: 0, compiles: 0, errors: 0 };

  const emit = (e) => {
    e = { t: Date.now(), ...e };
    say(e);
    try { o.onEvent(e); } catch {}
  };
  const fail = (where, err) => { n.errors++; emit({ type: 'error', where, error: String(err?.message ?? err) }); };
  const NOPE = Symbol('failed');
  /** Runs fn; on a throw (or rejection) reports it and returns NOPE, so the caller can route around it. */
  function safely(where, fn) {
    try {
      const v = fn();
      if (v && typeof v.then === 'function') return v.then((x) => x, (err) => { fail(where, err); return NOPE; });
      return v;
    } catch (err) { fail(where, err); return NOPE; }
  }

  // ── Startup: resume from the store when it has a model or a guarded state ──────────────────────────

  function adopt(saved, state) {
    available = store.size ?? 0;
    if (saved && saved !== NOPE) {
      model = saved;
      shape = saved.meta?.response ?? null;
      basis = saved.meta?.rows?.total ?? 0;
      mode = 'local';
    }
    if (state && state !== NOPE && state.guardedSince) {
      mode = 'guarded';
      incident = { t: state.guardedSince };
      basis = 0;
    }
    if (mode === 'local') emit({ type: 'start', mode, share: model.meta?.expected?.share ?? 0, target: model.meta?.certificate?.target ?? o.target });
    else if (mode === 'guarded') emit({ type: 'start', mode, since: incident.t });
    else if (auto) emit({ type: 'start', mode, min: auto.min, logged: available });
  }
  const saved = o.model ?? safely('loading the saved model', () => store.loadModel?.() ?? null);
  const state = safely('loading the saved state', () => store.loadState?.() ?? null);
  const ready = [saved, state].some((v) => typeof v?.then === 'function')
    ? Promise.all([saved, state]).then(([m, s]) => adopt(m, s))
    : Promise.resolve(adopt(saved, state));
  ready.then(() => maybeCompile());

  // ── Live checks ────────────────────────────────────────────────────────────────────────────────────

  function observe(agree) {
    if (ringN === ring.length) ringAgree -= ring[ringAt]; else ringN++;
    ring[ringAt] = agree ? 1 : 0;
    ringAgree += ring[ringAt];
    ringAt = (ringAt + 1) % ring.length;
    if (mode !== 'local') return;
    let alarm = false;
    for (let j = 0; j < cusum.length; j++) {
      cusum[j] = Math.max(0, cusum[j] + steps[j][agree ? 0 : 1]);
      if (cusum[j] >= CUSUM_H) alarm = true;
    }
    if (alarm) trip('drift', { slice: 'audit', agreement: ringAgree / ringN, sampled: ringN, target: o.target });
  }

  function observeDeferred(guess, confidence, agree) {
    if (dN === dring.length) dAgree -= dring[dAt]; else dN++;
    dring[dAt] = agree ? 1 : 0;
    dAgree += dring[dAt];
    dAt = (dAt + 1) % dring.length;
    const base = model?.meta?.expected?.deferred;
    if (mode !== 'local' || !base) return;
    if (dN >= DEFERRED_MIN && base.n >= 50) {
      const upper = wilson(dAgree, dN, GUARD_Z)[1];
      if (upper < base.agreement - DEFERRED_SLACK) return trip('drift', { slice: 'deferred', agreement: dAgree / dN, baseline: base.agreement, sampled: dN, upper });
    }
    // Per label: the model's calibrated confidence says how often your API should agree with its
    // guess. Far fewer agreements than that, beyond chance and slack, means your API changed.
    let r = byLabel.get(guess);
    if (!r) byLabel.set(guess, (r = { hit: new Uint8Array(LABEL_WINDOW), p: new Float64Array(LABEL_WINDOW), n: 0, at: 0 }));
    r.hit[r.at] = agree ? 1 : 0;
    r.p[r.at] = confidence;
    r.at = (r.at + 1) % LABEL_WINDOW;
    if (r.n < LABEL_WINDOW) r.n++;
    if (r.n < LABEL_MIN) return;
    let seen = 0, expected = 0, variance = 0;
    for (let k = 0; k < r.n; k++) { seen += r.hit[k]; expected += r.p[k]; variance += r.p[k] * (1 - r.p[k]); }
    const ratio = Math.min(1, base.ratio?.[guess] ?? 1); // how well confidence predicted agreement on calibration
    expected *= ratio;
    variance *= ratio;
    if (seen < expected - LABEL_SLACK * r.n - LABEL_Z * Math.sqrt(variance)) {
      trip('drift', { slice: 'deferred', label: guess, agreement: seen / r.n, baseline: expected / r.n, sampled: r.n });
    }
  }

  function resetChecks() { ringN = ringAgree = ringAt = 0; dN = dAgree = dAt = 0; byLabel.clear(); cusum.fill(0); }

  function trip(reason, detail) {
    if (mode === 'guarded') return;
    mode = 'guarded';
    epoch++;
    running?.abort();
    incident = { t: Date.now() };
    basis = fresh = sinceIncident = 0;
    resetChecks();
    persist('saving the guarded state', () => store.saveState?.({ guardedSince: incident.t }));
    emit({ type: 'guard', reason, ...detail });
  }

  // ── Calls ──────────────────────────────────────────────────────────────────────────────────────────

  async function detailed(input) {
    n.calls++;
    const t0 = now();
    const sample = mode !== 'local' || o.random() < o.audit;
    let d = null;
    // Until one response from your API has been seen, its shape is unknown, so it answers.
    if (mode === 'local' && model && (shape || o.respond)) {
      d = safely('the local model', () => model.decide(input, { probs: wantsProbs() }));
      if (d === NOPE) d = null;
      if (d?.local) {
        const value = safely('respond', () => answer(d));
        if (value !== NOPE) {
          n.local++;
          if (sample) audit(input, d.choice);
          return { value, source: 'local', choice: d.choice, confidence: d.confidence, ms: now() - t0 };
        }
      }
    }
    let resp;
    try {
      resp = await api(input);
    } catch (err) {
      if (!o.fallback || !model) throw err;
      d ??= safely('the local model', () => model.decide(input, { probs: wantsProbs() }));
      const value = d && d !== NOPE ? safely('respond', () => answer(d)) : NOPE;
      if (value === NOPE) throw err;
      n.fallback++;
      return { value, source: 'fallback', choice: d.choice, confidence: d.confidence, ms: now() - t0 };
    }
    n.api++;
    const choice = record(input, resp, sample);
    if (mode === 'local' && d && choice != null) observeDeferred(d.choice, d.confidence, d.choice === choice);
    if (sample && mode === 'local') observe(true);
    return { value: resp, source: 'api', choice, confidence: null, ms: now() - t0 };
  }

  function audit(input, localChoice) {
    n.audits++;
    Promise.resolve().then(() => api(input)).then((resp) => {
      const choice = record(input, resp, true);
      if (choice == null) return;
      const agree = choice === localChoice;
      if (!agree) n.auditDisagree++;
      emit({ type: 'audit', agree, local: localChoice, api: choice });
      if (mode === 'local') observe(agree);
    }, () => {}); // your API failing is your app's business; the audit is simply skipped
  }

  /** Logs one answer from your API. Returns the label, or null when none could be read. */
  function record(input, resp, sample) {
    shape ??= shapeOf(resp);
    const read = safely('choice', () => o.choice(resp, model?.labels ?? o.labels));
    const choice = read === NOPE ? null : read?.choice;
    if (choice == null) {
      if (!unreadable) { unreadable = true; emit({ type: 'unreadable', preview: preview(resp) }); }
      return null;
    }
    // A label nobody has seen yet joins the label set, so the next compile can learn it.
    if (o.labels && !o.labels.includes(choice)) o.labels = [...o.labels, choice];
    if (model && !model.labels.includes(choice)) trip('schema', { label: choice });
    const rec = { t: Date.now(), input, choice };
    if (read.probs) rec.probs = read.probs;
    if (o.group) {
      const g = safely('group', () => o.group(input));
      if (g != null && g !== NOPE) rec.group = String(g);
    }
    if (!sample) rec.sample = false;
    if (safely('saving an answer', () => store.append(rec)) !== NOPE) {
      available++; fresh++;
      if (mode === 'guarded') sinceIncident++;
      maybeCompile();
    }
    return choice;
  }

  const wantsProbs = () => !o.respond && shape?.probsKey != null;

  function answer(d) {
    if (o.respond) return o.respond(d, shape);
    if (!shape || shape.kind === 'string') return d.choice;
    const out = { [shape.key]: shape.numeric ? d.index : d.choice };
    if (shape.probsKey && d.probs) out[shape.probsKey] = shape.probsArray ? model.labels.map((l) => d.probs[l]) : d.probs;
    if (shape.confidence) out.confidence = d.confidence;
    return out;
  }

  // ── Compiles ───────────────────────────────────────────────────────────────────────────────────────

  function maybeCompile() {
    if (!auto || compiling || closed) return;
    const pool = mode === 'guarded' ? sinceIncident : available;
    if (pool < auto.min) return;
    const gap = basis ? Math.min(auto.maxEvery, Math.max(auto.min, basis * (auto.growth - 1))) : 0;
    if (fresh >= gap) recompile({ background: true }).catch((err) => fail('compile', err));
  }

  async function recompile({ background = false } = {}) {
    if (compiling) return compiling;
    if (closed) return null;
    compiling = (async () => {
      await ready;
      const started = epoch;
      const recovering = incident != null;
      fresh = 0;
      let rows = await store.load();
      if (incident) rows = rows.filter((r) => r.t >= incident.t);
      rows = rows.slice(-(auto?.window ?? 50_000));
      emit({ type: 'compile:start', rows: rows.length });
      n.compiles++;
      const ctrl = (running = new AbortController());
      let result = null;
      try {
        result = await o.compiler(rows, {
          target: o.target, delta: o.delta, audit: o.audit, labels: o.labels, ...o.compile, signal: ctrl.signal, background,
        });
      } catch (err) {
        if (err?.name !== 'AbortError') throw err;
      } finally {
        running = null;
        // Set even when the compile fails, so a failing compile is not retried on every call.
        if (epoch === started) basis = rows.length;
      }
      if (!result || epoch !== started || closed) {
        // The guard tripped while this compile ran, so its rows straddle the change. Never install it.
        emit({ type: 'discard', reason: closed ? 'closed' : 'guard tripped during compile' });
        return null;
      }
      const { model: next, report } = result;
      emit({ type: 'compile', report, recovering });
      if (report.calib.share > 0) {
        next.meta.response = shape;
        model = next;
        mode = 'local';
        incident = null;
        resetChecks();
        emit({ type: 'install', share: report.calib.share, verdict: report.verdict, model: next, report });
        await persist('saving the model', () => store.saveModel?.(next, report));
        await persist('saving the state', () => store.saveState?.(null));
      }
      return report;
    })();
    try { return await compiling; } finally { compiling = null; maybeCompile(); }
  }

  function persist(where, fn) {
    const v = safely(where, fn);
    return v && typeof v.then === 'function' ? v : Promise.resolve(v);
  }

  // ── The decide function ────────────────────────────────────────────────────────────────────────────

  const decide = async (input) => (await detailed(input)).value;
  decide.detailed = detailed;
  decide.local = (input) => (model ? model.decide(input) : null);
  decide.compile = () => recompile();
  decide.ready = ready;
  decide.close = async () => {
    closed = true;
    running?.abort();
    try { await compiling; } catch {}
    await persist('closing the store', () => store.close?.());
  };
  decide.stats = () => ({
    name: name ?? null, mode, ...n, logged: available,
    share: n.calls ? n.local / n.calls : 0,
    apiCallsSaved: n.local - n.audits,
    live: { sampled: ringN, agreement: ringN ? ringAgree / ringN : null, ci: ringN ? wilson(ringAgree, ringN) : null },
    deferred: { checked: dN, agreement: dN ? dAgree / dN : null, baseline: model?.meta?.expected?.deferred?.agreement ?? null },
    model: model ? { labels: model.labels.length, cutoff: model.cutoff, expectedShare: model.meta?.expected?.share ?? null, created: model.meta?.created ?? null } : null,
  });
  Object.defineProperty(decide, 'name', { value: name ?? 'decide' });
  Object.defineProperty(decide, 'model', { get: () => model });
  Object.defineProperty(decide, 'mode', { get: () => mode });
  if (Symbol.asyncDispose) decide[Symbol.asyncDispose] = decide.close;
  return decide;
}

/** Reads { choice, probs } from common response shapes: a label string, or { choice | label | decision | answer, probs }. */
export function defaultChoice(resp, labels) {
  if (typeof resp === 'string') return { choice: resp };
  if (!resp || typeof resp !== 'object') return { choice: null };
  let choice = resp.choice ?? resp.label ?? resp.decision ?? resp.answer ?? null;
  if (typeof choice === 'number' && labels) choice = labels[choice];
  let probs = resp.probs ?? resp.probabilities ?? null;
  if (Array.isArray(probs)) probs = labels ? Object.fromEntries(labels.map((l, k) => [l, probs[k]])) : null;
  return { choice: choice == null ? null : String(choice), probs };
}

/** The parts of a response local answers mirror: the label's key and type, and probs and confidence if present. */
function shapeOf(resp) {
  if (typeof resp === 'string') return { kind: 'string' };
  if (!resp || typeof resp !== 'object') return null;
  const key = LABEL_KEYS.find((k) => resp[k] != null) ?? 'choice';
  const probsKey = PROBS_KEYS.find((k) => resp[k] != null) ?? null;
  return { kind: 'object', key, numeric: typeof resp[key] === 'number', probsKey, probsArray: Array.isArray(resp[probsKey]), confidence: 'confidence' in resp };
}

function preview(resp) {
  let s;
  try { s = JSON.stringify(resp); } catch { s = String(resp); }
  s ??= String(resp);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validate(name, api, options) {
  const fail = (msg) => { throw new TypeError(`tinydecide: ${msg}`); };
  if (name !== undefined && (typeof name !== 'string' || !NAME.test(name))) {
    fail(`the name must be 1–64 letters, digits, dots, dashes or underscores, like "support-intent"; got ${JSON.stringify(name)}`);
  }
  if (typeof api !== 'function') fail(`shadow(${name ? `"${name}", ` : ''}api) needs your API call as a function, like (text) => classify(text); got ${typeof api}`);
  if (typeof options !== 'object') fail(`options must be an object; got ${typeof options}`);
  for (const k of Object.keys(options)) {
    if (k === 'dir') fail('"dir" only works in Node, where answers and models are saved to files');
    if (k === 'sink' || k === 'onModel') fail(`"${k}" was replaced by "store"; see the README`);
    if (!OPTIONS.includes(k)) fail(`unknown option "${k}". Options: ${OPTIONS.join(', ')}`);
  }
  const unit = (k, lo, hi) => {
    const v = options[k];
    if (v !== undefined && !(typeof v === 'number' && v > lo && v < hi)) fail(`${k} must be a number between ${lo} and ${hi}; got ${v}`);
  };
  unit('target', 0, 1); unit('delta', 0, 1);
  if (options.audit !== undefined && !(options.audit >= 0 && options.audit <= 1)) fail(`audit must be a rate from 0 to 1; got ${options.audit}`);
}
