import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lodashLib from 'lodash-es';
import * as ramdaLib from 'ramda';
import { lsd } from '../src/index.js';
import lodashPreset from '../src/lsd/presets/lodash.js';

test('readme example', () => {
  const normalizeKey = lsd.fn('trim toLowerCase');
  assert.equal(normalizeKey('  Content-Type '), 'content-type');
});

test('generates a single expression when possible', () => {
  assert.equal(lsd.code('trim toLowerCase'), '(it) => it.trim().toLowerCase()');
  assert.equal(lsd.code(''), '(it) => it');
});

test('binds a temp for ops that reuse their input', () => {
  assert.equal(
    lsd.code('trim capitalize'),
    '(it) => { const _0 = it.trim(); return (_0.charAt(0).toUpperCase() + _0.slice(1)); }',
  );
  assert.equal(lsd.fn('trim capitalize')('  moin '), 'Moin');
});

test('vocabulary ops', () => {
  assert.deepEqual(lsd.fn("split(',') compact unique")('a,,b,a'), ['a', 'b']);
  assert.equal(lsd.fn('slug')('  Grüße aus Köln! '), 'grusse-aus-koln');
  assert.equal(lsd.fn("or('n/a') upper")(null), 'N/A');
  assert.equal(lsd.fn('int')('42px'), 42);
  assert.equal(lsd.fn('words .length')(' a  b c '), 3);
  assert.deepEqual(lsd.fn('keys')({ a: 1, b: 2 }), ['a', 'b']);
});

test('explicit method bypasses the vocabulary', () => {
  assert.equal(lsd.code('.keys()'), '(it) => it.keys()');
  assert.equal(lsd.code('keys'), '(it) => Object.keys(it)');
});

test('validates op arity', () => {
  assert.throws(() => lsd.code('or'), /requires arguments/);
  assert.throws(() => lsd.code('lower(1)'), /takes no arguments/);
});

test('define extends the vocabulary', () => {
  lsd.define('double', (x) => `(${x} * 2)`);
  lsd.define({ inc: { emit: (x, args) => `(${x} + ${args ?? 1})`, args: 'optional' } });
  assert.equal(lsd.fn('num double inc(3)')('4'), 11);
});

test('caches functions per spec', () => {
  assert.equal(lsd.fn('trim'), lsd.fn('trim'));
});

test('sub-pipelines become callbacks of method calls', () => {
  assert.equal(lsd.code('map[trim lower]'), '(it) => it.map((it) => it.trim().toLowerCase())');
  assert.deepEqual(lsd.fn('map[trim lower] filter[.length]')([' A ', ' ', 'B']), ['a', 'b']);
  assert.equal(lsd.code('.reduce[.x](0)'), '(it) => it.reduce((it) => it.x, 0)');
});

test('native sortBy / groupBy / reverse', () => {
  assert.deepEqual(lsd.fn('sortBy[.name lower] map[.id]')([{ id: 1, name: 'b' }, { id: 2, name: 'A' }]), [2, 1]);
  assert.deepEqual(lsd.fn('sortBy')([3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(Object.keys(lsd.fn('groupBy[.length]')(['a', 'bb', 'c'])), ['1', '2']);
  assert.equal(lsd.fn('reverse')('abc'), 'cba');
  const input = [1, 2];
  assert.deepEqual(lsd.fn('reverse')(input), [2, 1]);
  assert.deepEqual(input, [1, 2]);
});

test('library steps need a registered library', () => {
  assert.throws(() => lsd.code('nope::x'), /unknown library 'nope'/);
  assert.throws(() => lsd.code('esToolkit::chunk'), /lsd.use\('esToolkit'/);
});

test('library steps call registered libraries', () => {
  lsd.use('lodash', lodashLib);
  lsd.use('ramda', ramdaLib);
  assert.equal(lsd.fn('trim lodash::kebabCase reverse')('  Hello World '), 'dlrow-olleh');
  assert.deepEqual(lsd.fn('_::chunk(2)')([1, 2, 3]), [[1, 2], [3]]);
  // ramda is data-last
  assert.equal(lsd.code('R::take(2)'), '(it) => $libs.ramda.take(2, it)');
  assert.deepEqual(lsd.fn('R::map[upper] R::take(2)')(['a', 'b', 'c']), ['A', 'B']);
  assert.throws(() => lsd.code('lodash::nope'), /not a function/);
});

test('custom libraries', () => {
  lsd.use('mine', { wrap: (pre, v) => `${pre}${v}` }, { order: 'data-last' });
  assert.equal(lsd.fn("mine::wrap('> ')")('x'), '> x');
});

test('macros and the lodash preset', () => {
  lsd.define({ clean: 'trim lower', shout: 'upper' });
  assert.equal(lsd.fn('clean shout')('  Hi '), 'HI');
  assert.throws(() => lsd.code('clean(1)'), /takes no arguments/);

  lsd.define({ loop: 'loop2', loop2: 'loop' });
  assert.throws(() => lsd.code('loop'), /recursive macro/);

  lsd.define(lodashPreset);
  assert.equal(lsd.code('chunk(2)'), '(it) => $libs.lodash.chunk(it, 2)');
  assert.equal(lsd.fn('sortBy[.age] first .name camel')([{ name: 'b b', age: 2 }, { name: 'a a', age: 1 }]), 'aA');
  assert.deepEqual(lsd.fn("pick('a', 'c')")({ a: 1, b: 2, c: 3 }), { a: 1, c: 3 });
});

test('expression steps use it as the current value', () => {
  assert.equal(lsd.fn("trim (it + '!') upper")(' hi '), 'HI!');
  assert.equal(lsd.code('(it * 2) (it + 1)'), '(it) => { it = (it * 2); return (it + 1); }');
  assert.deepEqual(lsd.fn('map[(it * 2)]')([1, 2]), [2, 4]);
});

test('multi-param pipelines', () => {
  assert.equal(lsd.fn('reduce[acc it => (acc + it.price)](0)')([{ price: 2 }, { price: 3 }]), 5);
  assert.equal(lsd.fn('a b => (a + b)')(1, 2), 3);
  // the pipeline runs on `it` if present, otherwise on the first param
  assert.equal(lsd.code('key it => .name'), '(key, it) => it.name');
  assert.equal(lsd.code('a b => .name'), '(a, b) => a.name');
  assert.throws(() => lsd.code('a a => (a)'), /duplicate param/);
});

test('tagged templates capture outer values', () => {
  const fallback = 'anon';
  const exclaim = (s) => `${s}!`;
  const greet = lsd.fn`or(${fallback}) trim ${exclaim}`;
  assert.equal(greet(null), 'anon!');
  assert.equal(greet(' x '), 'x!');
  // raw strings keep regex escapes
  assert.equal(lsd.fn`replace(/\s+/g, '-')`('a b  c'), 'a-b-c');
  // every evaluation captures the current values
  const results = [1, 2].map((n) => lsd.fn`(it * ${n})`(10));
  assert.deepEqual(results, [10, 20]);
  assert.throws(() => lsd.code('$0'), /unknown capture/);
});

test('prefer and typo hints', () => {
  lsd.use('lodash', lodashLib);
  assert.throws(() => lsd.code('lodash::kebabcase'), /did you mean 'kebabCase'/);
  assert.throws(() => lsd.code('lodahs::chunk'), /did you mean 'lodash'/);
  lsd.prefer('lodash');
  try {
    assert.equal(lsd.code('kebabCase .trim() nope'), '(it) => $libs.lodash.kebabCase(it).trim().nope()');
    assert.equal(lsd.fn('camelCase')('foo bar'), 'fooBar');
  } finally {
    lsd.prefer();
  }
  assert.equal(lsd.code('camelCase'), '(it) => it.camelCase()');
});
