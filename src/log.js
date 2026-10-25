// One plain-English line per lifecycle event, so the moment a decision graduates, falls back to your
// API, or recovers is visible in your logs. Nothing is logged per call.

const pct = (x) => `${Math.round(x * 100)}%`;
const int = (x) => x.toLocaleString('en-US');
const UNTIL = 'Every call goes to your API until a model trained on its new answers certifies.';

/** @returns {string | null} */
export function describe(e) {
  switch (e.type) {
    case 'start':
      if (e.mode === 'guarded') return `guarded since ${new Date(e.since).toISOString()}. ${UNTIL}`;
      if (e.mode === 'local') return `loaded the saved model: it answers about ${pct(e.share)} of calls locally at ≥ ${pct(e.target)} agreement with your API.`;
      return `learning from your API. First compile after ${int(e.min)} answers${e.logged ? ` (${int(e.logged)} logged so far)` : ''}.`;
    case 'compile': {
      const r = e.report;
      const from = `compiled from ${int(r.rows.total)} answers${e.recovering ? ' since the change' : ''}`;
      if (r.calib.share > 0) {
        return `${from}: answers ${pct(r.calib.share)} of calls locally, with ≥ ${pct(r.target)} agreement with your API certified at ${pct(1 - r.delta)} confidence. ${(r.bytes / 1e6).toFixed(2)} MB, ${r.latencyUs} µs per call.`;
      }
      return `${from}. Nothing certified yet, so your API keeps every call. ${r.summary}`;
    }
    case 'guard':
      if (e.reason === 'schema') return `your API returned a label the model has never seen ("${e.label}"). ${UNTIL}`;
      if (e.slice === 'deferred' && e.label) return `your API's answers changed for "${e.label}": on calls the model leaned toward "${e.label}" but left to your API, they now agree ${pct(e.agreement)} of the time where the model expected ${pct(e.baseline)}. ${UNTIL}`;
      if (e.slice === 'deferred') return `your API's answers changed: on calls it answered itself, the model now agrees ${pct(e.agreement)} of the time, down from ${pct(e.baseline)}. ${UNTIL}`;
      return `your API's answers changed: the model agreed on only ${pct(e.agreement)} of ${int(e.sampled)} audited calls (target ${pct(e.target)}). ${UNTIL}`;
    case 'unreadable':
      return `could not find a label in your API's response ${e.preview}. Return a label string or an object with a "label" field, or pass choice: (response) => label. Calls still work; they just teach nothing.`;
    case 'error':
      return `${e.where} failed: ${e.error}`;
    default:
      return null;
  }
}

/**
 * @param {string | undefined} name
 * @param {boolean | ((line: string, event: object) => void)} log
 */
export function logger(name, log) {
  if (!log) return () => {};
  const write = typeof log === 'function' ? log : (line) => console.info(line);
  const prefix = `[tinydecide]${name ? ` ${name}:` : ''} `;
  let last = '', lastAt = 0;
  return (e) => {
    const line = describe(e);
    if (!line) return;
    // A failure that repeats (a full disk, a store that is down) is logged once a minute, not per call.
    if (e.type === 'error') {
      if (line === last && Date.now() - lastAt < 60_000) return;
      last = line; lastAt = Date.now();
    }
    try { write(prefix + line, e); } catch {}
  };
}
