#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { supportApi } from '../examples/support-api.js';
import { compile, loadModel, memoryStore, readJsonl, saveModel, shadow } from '../src/node.js';

const HELP = `tinydecide: wrap your decision API; answer the calls it can locally, with agreement certified

usage
  tinydecide try                 a 15 s simulation, no keys: learn a simulated API, which then changes
  tinydecide status [dir]        what each decision in .tinydecide/ is doing
  tinydecide compile <answers>   compile a model from a .jsonl log, or a decision folder
                     [--out model.tdm] [--target 0.98] [--delta 0.05] [--guarantee overall|local]
                     [--labels a,b,c] [--audit 0.02] [--report report.json]
  tinydecide inspect <model.tdm> print a model's labels and certificate
  tinydecide decide  <model.tdm> [text …]   answer inputs; reads one per line from stdin when none are given

in code
  import { shadow } from 'tinydecide';
  const classify = shadow('support', (text) => yourApi.classify(text));`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint('2'), bold = paint('1'), green = paint('32'), yellow = paint('33'), red = paint('31'), blue = paint('34');
const pct = (x, digits = 1) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
const int = (x) => Math.round(x).toLocaleString('en-US');

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else pos.push(a);
  }
  return { pos, flags };
}

const VERDICT = {
  ship: () => green('✓ ship'),
  marginal: () => yellow('~ marginal'),
  'not-worth-it': () => red('× not worth it'),
  'need-more-data': () => yellow('… need more data'),
};

// ── try ──────────────────────────────────────────────────────────────────────────────────────────────

async function cmdTry(f) {
  const CALLS = +(f.calls ?? 14_000), CHANGE_AT = Math.round(CALLS * 0.55), RATE = +(f.rate ?? 1000);
  const API_MS = 400, PRICE = 0.4 / 1000;
  const sim = supportApi({ seed: +(f.seed ?? 1) });
  const out = process.stdout;
  const width = Math.min(out.columns || 100, 110);
  // before the change · between the change and the guard · after the guard
  const phase = [{ local: 0, right: 0, calls: 0 }, { local: 0, right: 0, calls: 0 }, { local: 0, right: 0, calls: 0 }];
  let i = 0, p = 0, status = '', last = null;
  const recent = new Uint8Array(500), agree = new Uint8Array(500);
  let agreeN = 0;

  const wrap = (text, indent) => {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      if (line && indent + visible(line).length + 1 + visible(word).length > width - 2) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    return lines.join(`\n${' '.repeat(indent)}`);
  };
  const clear = () => { if (tty && status) out.write('\r\x1b[2K'); };
  const draw = () => {
    if (!tty) return;
    const share = recent.reduce((a, x) => a + x, 0) / Math.min(Math.max(i, 1), recent.length);
    const n = Math.min(agreeN, agree.length), ok = agree.reduce((a, x) => a + x, 0);
    status = `  ${dim('calls')} ${int(i).padStart(6)}   ${dim('answered locally')} ${blue(pct(share, 0).padStart(4))}   ${dim('agreement on recent local answers')} ${n ? pct(ok / n) : '—'}`;
    out.write(`\r\x1b[2K${status}`);
  };
  const say = (line) => { clear(); out.write(`${dim(int(i).padStart(8))}  ${wrap(line, 10)}\n`); draw(); };

  out.write(`\n  ${bold('tinydecide try')}\n\n`);
  out.write(`  ${wrap(`A simulated support-ticket classifier stands in for your API: ${sim.labels.length} labels, ${API_MS} ms and $0.40 per 1,000 calls (assumed). TinyDecide wraps it. Partway through, the API changes how it labels some messages.`, 2)}\n\n`);

  const decide = shadow('support', sim.api, {
    store: memoryStore(),
    log: (line, e) => {
      if (e.type === 'compile') last = e.report;
      if (e.type === 'guard' && p === 1) p = 2; // only after the scripted change
      say(line.replace(/^\[tinydecide\] support: /, ''));
    },
  });

  const t0 = Date.now();
  for (; i < CALLS; i++) {
    if (i === CHANGE_AT) { p = 1; say(yellow(`▸ ${sim.change()}. Nothing tells TinyDecide.`)); }
    const text = sim.next();
    const d = await decide.detailed(text);
    const isLocal = d.source === 'local';
    recent[i % recent.length] = isLocal ? 1 : 0;
    phase[p].calls++;
    if (isLocal) {
      const right = d.choice === sim.truth(text);
      phase[p].local++;
      if (right) phase[p].right++;
      agree[agreeN++ % agree.length] = right ? 1 : 0;
    }
    if (i % 25 === 0) {
      draw();
      const ahead = ((i + 1) / RATE) * 1000 - (Date.now() - t0);
      await new Promise((r) => setTimeout(r, Math.max(0, ahead)));
    }
  }
  const s = decide.stats();
  clear();
  await decide.close();

  const local = phase.reduce((a, x) => a + x.local, 0);
  const row = (k, v) => out.write(`  ${dim(k.padEnd(18))}${wrap(v, 20)}\n`);
  // Overall agreement, as certified: your API's own answers count as agreeing.
  const rate = (x) => (x.calls ? pct(1 - (x.local - x.right) / x.calls) : '—');
  out.write(`\n  ${bold('Done.')} ${int(CALLS)} calls, ${int(local)} answered locally ${dim(`(${pct(local / CALLS, 0)})`)}.\n\n`);
  row('agreement', `${rate(phase[0])} before the change, ${rate(phase[2])} after the guard ${dim('(overall, as certified; checked on every call, which only a simulation can do)')}`);
  if (p === 2) row('the change', `caught after ${int(phase[1].calls)} calls; ${int(phase[1].local - phase[1].right)} local answers were wrong in that window`);
  row('API calls saved', `${int(s.apiCallsSaved)} ${dim(`$${(s.apiCallsSaved * PRICE).toFixed(2)} and ${(s.apiCallsSaved * API_MS / 60_000).toFixed(0)} min of waiting, at the assumed price and latency`)}`);
  if (last) row('time per answer', `${last.latencyUs} µs locally, vs ${API_MS} ms from your API`);
  out.write(`\n  ${dim('Next: wrap your own API')}\n\n    import { shadow } from 'tinydecide';\n    const classify = shadow('support', (text) => yourApi.classify(text));\n\n`);
}

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── status ───────────────────────────────────────────────────────────────────────────────────────────

function cmdStatus(dir = process.env.TINYDECIDE_DIR || '.tinydecide') {
  if (!existsSync(dir)) {
    console.log(`\n  No decisions in ${dir}/ yet. Wrap your API with shadow('name', api) and run your app.\n`);
    return;
  }
  const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
  console.log(`\n  ${bold(dir + '/')}\n`);
  if (!names.length) console.log(dim('  (empty)'));
  const width = Math.max(...names.map((n) => n.length), 8);
  for (const name of names) {
    const at = (f) => join(dir, name, f);
    const answers = existsSync(at('answers.jsonl')) ? countLines(at('answers.jsonl')) : 0;
    const report = readJson(at('report.json'));
    const state = readJson(at('state.json'));
    const mode = state?.guardedSince ? 'guarded' : existsSync(at('model.tdm')) ? 'local' : 'learning';
    const color = { local: blue, learning: dim, guarded: yellow }[mode];
    let detail;
    if (mode === 'guarded') detail = `back to your API ${ago(state.guardedSince)}; relearning from its new answers`;
    else if (mode === 'local' && report) detail = `answers about ${pct(report.calib.share, 0)} locally at ≥ ${pct(report.target, 0)} agreement · compiled ${ago(Date.parse(statSync(at('model.tdm')).mtime))}`;
    else detail = report ? `last compile: ${report.verdict}` : 'every call goes to your API until the first compile';
    console.log(`  ${name.padEnd(width)}  ${color(mode.padEnd(8))}  ${int(answers).padStart(8)} answers   ${dim(detail)}`);
  }
  console.log('');
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function countLines(path) {
  const buf = readFileSync(path);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return n;
}

// ── compile, inspect, decide ─────────────────────────────────────────────────────────────────────────

async function cmdCompile(file, f) {
  if (!file) throw new Error('compile needs a .jsonl file of answers, or a decision folder like .tinydecide/support');
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'answers.jsonl');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  let skippedLines = 0;
  const records = readJsonl(file, { onSkip: () => skippedLines++ });
  const out = f.out ?? file.replace(/\.jsonl(\.gz)?$/, '') + '.tdm';
  const opts = {
    target: f.target ? +f.target : undefined, delta: f.delta ? +f.delta : undefined,
    guarantee: f.guarantee, audit: f.audit ? +f.audit : undefined, seed: f.seed ? +f.seed : undefined,
    labels: f.labels ? String(f.labels).split(',') : undefined,
  };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  let shown = -1;
  const { model, report } = await compile(records, {
    ...opts,
    onProgress: ({ phase, done }) => {
      if (!process.stderr.isTTY || phase !== 'train') return;
      const p = Math.floor(done * 20);
      if (p !== shown) { shown = p; process.stderr.write(`\r  training ${'▮'.repeat(p)}${dim('▯'.repeat(20 - p))}`); }
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
  saveModel(out, model);
  if (f.report) writeFileSync(f.report, JSON.stringify(report, null, 2) + '\n');

  const r = report, t = r.test;
  const scope = r.guarantee === 'local' ? 'agreement on local answers' : 'overall agreement';
  console.log(`\n  ${bold('tinydecide compile')}  ${basename(file)} ${dim('→')} ${basename(out)}\n`);
  console.log(dim(`  ${int(r.rows.total)} calls · ${r.labels.length} labels · target ${pct(r.target, 1)} ${scope} (${pct(1 - r.delta, 0)} confidence)${skippedLines ? ` · ${skippedLines} unreadable lines skipped` : ''}\n`));
  console.log(`  ${VERDICT[r.verdict]()}   ${r.summary}\n`);
  const row = (k, v) => console.log(`  ${dim(k.padEnd(15))}  ${v}`);
  if (t) row('held-out check', `${int(t.n)} calls   ${pct(t.share)} local   ${pct(t.overallAgreement)} agreement ${dim(`[${pct(t.overallCI[0])}–${pct(t.overallCI[1])}]`)}`);
  if (t?.localAgreement != null) row('local answers', `${pct(t.localAgreement)} agree with your API`);
  row('what if', r.whatIf.map((w) => `${pct(w.target, w.target >= 0.99 ? 1 : 0)} ${dim('→')} ${pct(w.share, 0)}`).join('   '));
  row('model', `${(r.bytes / 1e6).toFixed(2)} MB · ${int(r.features)} features · ${r.latencyUs} µs per call · trained in ${(r.ms.train / 1000).toFixed(1)} s`);
  console.log('');
}

function cmdInspect(file) {
  if (!file) throw new Error('inspect needs a .tdm model file');
  const m = loadModel(file);
  console.log(JSON.stringify({
    labels: m.labels, features: m.keys.length, d: m.d, bytes: m.bytes, temperature: m.T,
    cutoff: Number.isFinite(m.cutoff) ? m.cutoff : null, certificate: m.meta?.certificate ?? {}, expected: m.meta?.expected, created: m.meta?.created,
  }, null, 2));
}

async function cmdDecide(file, texts) {
  if (!file) throw new Error('decide needs a .tdm model file');
  const m = loadModel(file);
  const one = (s) => {
    let input = s;
    try { const j = JSON.parse(s); if (j && typeof j === 'object') input = j; } catch {}
    const d = m.decide(input);
    console.log(JSON.stringify({ choice: d.choice, confidence: +d.confidence.toFixed(4), local: d.local }));
  };
  if (texts.length) return texts.forEach(one);
  for await (const line of createInterface({ input: process.stdin })) if (line.trim()) one(line);
}

const { pos, flags } = parse(process.argv.slice(2));
const [cmd, ...rest] = pos;
try {
  if (cmd === 'try') await cmdTry(flags);
  else if (cmd === 'status') cmdStatus(rest[0]);
  else if (cmd === 'compile') await cmdCompile(rest[0], flags);
  else if (cmd === 'inspect') cmdInspect(rest[0]);
  else if (cmd === 'decide') await cmdDecide(rest[0], rest.slice(1));
  else if (!cmd || cmd === 'help' || cmd === '-h' || flags.help) console.log(HELP);
  else throw new Error(`unknown command "${cmd}". Run tinydecide help.`);
} catch (err) {
  console.error(`tinydecide: ${err.message}`);
  process.exit(1);
}
