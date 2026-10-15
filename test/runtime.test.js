import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lsd } from '../src/index.js';

test('readme example', () => {
  const normalizeKey = lsd.fn('trim toLowerCase');
  assert.equal(normalizeKey('  Content-Type '), 'content-type');
});

test('generates a single expression when possible', () => {
  assert.equal(lsd.code('trim toLowerCase'), '(v) => v.trim().toLowerCase()');
  assert.equal(lsd.code(''), '(v) => v');
});

test('binds a temp for ops that reuse their input', () => {
  assert.equal(
    lsd.code('trim capitalize'),
    '(v) => { const _0 = v.trim(); return (_0.charAt(0).toUpperCase() + _0.slice(1)); }',
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
  assert.equal(lsd.code('.keys()'), '(v) => v.keys()');
  assert.equal(lsd.code('keys'), '(v) => Object.keys(v)');
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
