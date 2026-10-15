import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, LsdSyntaxError } from '../src/lsd/index.js';

test('splits steps on whitespace', () => {
  assert.deepEqual(
    parse('trim  toLowerCase').map((step) => step.name),
    ['trim', 'toLowerCase'],
  );
});

test('keeps whitespace, parens and quotes inside args', () => {
  const [step] = parse("split(') (')");
  assert.equal(step.args, "') ('");
});

test('handles regex literals in args', () => {
  const [step] = parse('replace(/\\)+ /g, "")');
  assert.equal(step.args, '/\\)+ /g, ""');
});

test('parses property paths and explicit methods', () => {
  assert.deepEqual(parse('.a.b.c()'), [
    { type: 'prop', path: ['a', 'b'], start: 0 },
    { type: 'method', name: 'c', args: '', start: 0 },
  ]);
});

test('reports position on syntax errors', () => {
  assert.throws(() => parse('trim split(","'), (error) => error instanceof LsdSyntaxError && error.pos === 10);
  assert.throws(() => parse('trim#'), LsdSyntaxError);
  assert.throws(() => parse('1abc'), LsdSyntaxError);
});
