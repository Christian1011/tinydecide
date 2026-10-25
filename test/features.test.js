import assert from 'node:assert/strict';
import test from 'node:test';
import { Featurizer, asInput, inputKey, normalize } from '../src/features.js';

const fz = new Featurizer();

test('features are deterministic and case / width insensitive', () => {
  const a = fz.copy('Reset my PASSWORD please'), b = fz.copy('reset my password please');
  assert.deepEqual(a, b);
  assert.deepEqual(fz.copy('ｒｅｓｅｔ'), fz.copy('reset'));
  assert.ok(a.w.length >= 7 && a.c.length > 20);
});

test('CJK characters become their own tokens', () => {
  const { w } = fz.copy('我想取消订单');
  assert.equal(w.length, 6 + 5); // six character unigrams and five bigrams
});

test('pairs are not the same as concatenated text', () => {
  const pair = fz.copy({ a: 'the cat sat', b: 'the cat slept' });
  const flat = fz.copy('the cat sat the cat slept');
  assert.notDeepEqual(pair.w, flat.w);
  assert.notDeepEqual(fz.copy({ a: 'x y', b: 'y z' }).w, fz.copy({ a: 'y z', b: 'x y' }).w);
});

test('inputs accept strings, state / text objects and pairs', () => {
  assert.deepEqual(asInput('hi'), { text: 'hi' });
  assert.deepEqual(asInput({ state: 'hi' }), { text: 'hi' });
  assert.deepEqual(asInput({ a: 'p', b: 'q' }), { a: 'p', b: 'q' });
  assert.equal(inputKey({ text: 'Hello' }), 'hello');
  assert.equal(normalize('ＡＢＣ'), 'abc');
  assert.equal(asInput({ z: 1, a: 'two' }).text, 'a: two\nz: 1');
});

test('numbers add a length shape so unseen numbers still share a feature', () => {
  const a = fz.copy('order 1234'), b = fz.copy('order 9876');
  const shared = [...a.w].filter((h) => b.w.includes(h));
  assert.ok(shared.length >= 2); // "order" and the 4-digit shape
});
