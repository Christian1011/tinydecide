// The Node entry. Same API as the browser build, plus:
//   - shadow('name', api) keeps answers, the model and its state in .tinydecide/name/, so a restart
//     resumes where it left off
//   - compiles train in a worker thread, off your server's event loop

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { compile } from './compile.js';
import { logger } from './log.js';
import { Model } from './model.js';
import { NAME, shadow as core, validate } from './shadow.js';
import { memoryStore } from './store.js';
import { abortError } from './train.js';

export * from './index.js';

/**
 * shadow('support', api, options): in Node, a named decision is saved under `dir` (default
 * .tinydecide, or $TINYDECIDE_DIR) and resumes after a restart.
 */
export function shadow(name, api, options) {
  if (typeof name === 'function') return core(name, { compiler: compileInWorker, ...api });
  const { dir = process.env.TINYDECIDE_DIR || '.tinydecide', ...rest } = options ?? {};
  if (typeof name !== 'string' || !NAME.test(name)) return core(name, api, rest); // core explains the error
  validate(name, api, rest); // before anything touches the disk
  let store = rest.store;
  if (!store) {
    try {
      store = fileStore(join(dir, name));
    } catch (err) {
      // A folder that can't be written, or that another process holds, must not stop the app.
      store = memoryStore();
      logger(name, rest.log ?? true)({ type: 'error', where: `opening ${join(dir, name)}`, error: `${err.message}. Answers stay in memory.` });
    }
  }
  return core(name, api, { compiler: compileInWorker, ...rest, store });
}

/**
 * Keeps one decision in a folder:
 *   answers.jsonl  your API's recent answers (trimmed to the newest `limit`)
 *   model.tdm      the installed model, and report.json, its compile report
 *   state.json     present only while guarded
 *   lock           the pid of the process using the folder; a second store on it throws
 * Writes of the model and state are atomic.
 */
export function fileStore(dir, { limit = 100_000 } = {}) {
  const root = dirname(dir);
  const fresh = !existsSync(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The log holds raw inputs, so keep the whole folder out of git unless someone opts in.
  if (fresh) safeWrite(join(root, '.gitignore'), '# created by tinydecide: answers.jsonl holds raw inputs\n*\n');
  const path = { answers: join(dir, 'answers.jsonl'), model: join(dir, 'model.tdm'), report: join(dir, 'report.json'), state: join(dir, 'state.json'), lock: resolve(dir, 'lock') };
  takeLock(path.lock);
  let fd = -1, size = 0;

  function open() {
    size = 0;
    if (existsSync(path.answers)) {
      const buf = readFileSync(path.answers);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) size++;
      // A crash mid-write can leave a partial last line; end it so the next answer starts clean.
      if (buf.length && buf[buf.length - 1] !== 10) writeFileSync(path.answers, '\n', { flag: 'a' });
    }
    fd = openSync(path.answers, 'a', 0o600);
  }
  open();

  /** Keeps the newest `limit` lines. Scans bytes for newlines, so nothing is parsed. */
  function trim() {
    const buf = readFileSync(path.answers);
    let at = buf.length - 1; // the newline that ends the last line
    for (let k = 0; k < limit && at > 0; k++) at = buf.lastIndexOf(10, at - 1);
    closeSync(fd); // first: Windows will not rename over a file that is still open
    fd = -1;
    try {
      atomicWrite(path.answers, buf.subarray(at + 1));
    } finally {
      open();
      size = Math.min(size, limit); // after a failure, wait another quarter of `limit` before retrying
    }
  }

  return {
    dir,
    append(record) {
      writeSync(fd, JSON.stringify(record) + '\n');
      if (++size > limit * 1.25) trim();
    },
    load: () => readJsonl(path.answers).slice(-limit),
    get size() { return size; },
    loadModel: () => (existsSync(path.model) ? Model.fromBytes(readFileSync(path.model)) : null),
    saveModel(model, report) {
      atomicWrite(path.model, model.toBytes());
      atomicWrite(path.report, JSON.stringify(report, null, 2) + '\n');
    },
    loadState() {
      if (!existsSync(path.state)) return null;
      try { return JSON.parse(readFileSync(path.state, 'utf8')); } catch { return null; }
    },
    saveState(state) {
      if (state) atomicWrite(path.state, JSON.stringify(state) + '\n');
      else rmSync(path.state, { force: true });
    },
    close() {
      if (fd < 0) return;
      closeSync(fd);
      fd = -1;
      rmSync(path.lock, { force: true });
      held.delete(path.lock);
    },
  };
}

const held = new Set(); // lock files this process holds

/** One process per folder: a second writer would lose answers when the log is trimmed. */
function takeLock(path) {
  if (held.has(path)) throw new Error(`${dirname(path)} is already open in this process`);
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(readFileSync(path, 'utf8'));
    // Our own pid here means an earlier run left it, as when a container restarts with the same pid.
    if (pid && pid !== process.pid && alive(pid)) {
      throw new Error(`${dirname(path)} is in use by process ${pid}. Use one process per folder, or delete ${path} if that process is not using it`);
    }
    rmSync(path, { force: true }); // stale: the process that wrote it is gone
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  held.add(path);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

let workerBroken = false;

/** compile() in a worker thread. Falls back to the calling thread if workers are unavailable. */
function compileInWorker(rows, options = {}) {
  const { signal, onProgress, background, ...rest } = options;
  if (workerBroken) return compile(rows, { ...rest, signal, onProgress });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; signal?.removeEventListener('abort', abort); fn(v); } };
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { rows, options: rest } });
    } catch {
      workerBroken = true;
      return compile(rows, { ...rest, signal, onProgress }).then(resolve, reject);
    }
    if (background) worker.unref(); // an automatic compile never keeps a finished process alive
    function abort() { worker.terminate(); done(reject, abortError()); }
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (m) => {
      if (m.error) return done(reject, Object.assign(new Error(m.error.message), { name: m.error.name }));
      done(resolve, { model: Model.fromBytes(m.bytes), report: m.report });
    });
    let fallback = false;
    worker.once('error', (err) => {
      // The worker could not start (a bundler that drops worker.js, say): compile here instead.
      if (['ERR_WORKER_PATH', 'ERR_MODULE_NOT_FOUND', 'ERR_WORKER_INIT_FAILED'].includes(err?.code)) {
        workerBroken = fallback = true;
        compile(rows, { ...rest, signal, onProgress }).then((v) => done(resolve, v), (e) => done(reject, e));
      } else done(reject, err);
    });
    worker.once('exit', (code) => { if (!fallback) done(reject, new Error(`the compile worker exited with code ${code}`)); });
  });
}

/** Reads a .jsonl or .jsonl.gz file. Lines that are not valid JSON (a crash mid-write) are skipped. */
export function readJsonl(path, { onSkip } = {}) {
  if (!existsSync(path)) return [];
  let buf = readFileSync(path);
  if (path.endsWith('.gz')) buf = gunzipSync(buf);
  const out = [];
  let line = 0;
  for (const raw of buf.toString('utf8').split('\n')) {
    line++;
    const s = raw.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { onSkip?.(line); }
  }
  return out;
}

export function loadModel(path) {
  return Model.fromBytes(readFileSync(path));
}

export function saveModel(path, model) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, model.toBytes());
}

function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function safeWrite(path, data) {
  try { writeFileSync(path, data, { flag: 'wx' }); } catch {}
}
