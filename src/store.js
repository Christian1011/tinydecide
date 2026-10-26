// Where shadow() keeps your API's answers, the installed model, and whether it is guarded.
//
// A store needs append(record), load() → recent records (oldest first) and size. The model and
// state methods are optional; without them a restart starts from scratch, which is always safe.
// The file store lives in ./node.js so this module stays browser-safe.

/** Keeps everything in memory: the default in browsers and workers. */
export function memoryStore({ limit = 100_000, records = [] } = {}) {
  const rows = records.slice(-limit);
  let model = null, state = null;
  return {
    append(record) { rows.push(record); if (rows.length > limit * 1.25) rows.splice(0, rows.length - limit); },
    load() { return rows.slice(-limit); },
    get size() { return rows.length; },
    get records() { return rows; },
    loadModel: () => model,
    saveModel(m) { model = m; },
    loadState: () => state,
    saveState(s) { state = s; },
  };
}
