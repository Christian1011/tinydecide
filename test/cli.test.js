import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toyTraffic } from './helpers.js';

const bin = fileURLToPath(new URL('../bin/tinydecide.js', import.meta.url));

test('compile, inspect and decide from the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinydecide-'));
  const file = join(dir, 'support.jsonl');
  writeFileSync(file, toyTraffic(4000).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = execFileSync(process.execPath, [bin, 'compile', file, '--report', join(dir, 'r.json')], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(out, /✓ ship/);
  assert.match(out, /held-out check/);
  assert.ok(existsSync(join(dir, 'support.tdm')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).verdict, 'ship');
  const info = JSON.parse(execFileSync(process.execPath, [bin, 'inspect', join(dir, 'support.tdm')], { encoding: 'utf8' }));
  assert.equal(info.labels.length, 4);
  const line = execFileSync(process.execPath, [bin, 'decide', join(dir, 'support.tdm'), 'w1 billingx00 w2'], { encoding: 'utf8' });
  assert.equal(JSON.parse(line).choice, 'billing');
});
