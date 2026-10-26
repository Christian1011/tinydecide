// Guard check: after a one-label API change, how many calls until the guard trips, and how many
// local answers were wrong meanwhile. Also runs with no change, to count false alarms.
//   node bench/guard-drift.js change 10        node bench/guard-drift.js none 12 40000
import { supportApi } from '../examples/support-api.js';
import { rng } from '../src/hash.js';
import { shadow } from '../src/node.js';
const [, , kind = 'change', seeds = '8', calls = '16000'] = process.argv;
const settle = () => new Promise((r) => setImmediate(r));
const rows = [];
for (let seed = 1; seed <= +seeds; seed++) {
  const sim = supportApi({ seed });
  const guards = [];
  let i = 0, compiling = false;
  const d = shadow(sim.api, { log: false, random: rng(seed * 7), onEvent: (e) => {
    if (e.type === 'guard') guards.push({ at: i, slice: e.slice ?? e.reason, label: e.label ?? '' });
    if (e.type === 'compile:start') compiling = true;
    if (e.type === 'compile' || e.type === 'discard') compiling = false;
  } });
  const CHANGE = 7700;
  let wrongAfter = 0, localAfter = 0;
  for (; i < +calls; i++) {
    if (kind === 'change' && i === CHANGE) sim.change();
    const text = sim.next();
    const r = await d.detailed(text);
    if (i >= CHANGE && r.source === 'local') { localAfter++; if (r.choice !== sim.truth(text)) wrongAfter++; }
    if (kind === 'change' && i >= CHANGE && guards.length) break;
    while (compiling) await new Promise((r) => setTimeout(r, 2)); // compiles finish "between" calls, so runs are repeatable
    if (i % 50 === 0) await settle();
  }
  await d.close();
  rows.push({ seed, guards: guards.map((g) => `${g.at}:${g.slice}${g.label ? '/' + g.label : ''}`).join(' '), detectAfter: kind === 'change' && guards[0] ? guards[0].at - CHANGE : '', wrongLocalBeforeDetect: kind === 'change' ? wrongAfter : '' });
}
console.table(rows);
