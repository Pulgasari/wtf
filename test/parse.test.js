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
    { type: 'method', name: 'c', args: '', body: null, start: 0 },
  ]);
});

test('reports position on syntax errors', () => {
  assert.throws(() => parse('trim split(","'), (error) => error instanceof LsdSyntaxError && error.pos === 10);
  assert.throws(() => parse('trim#'), LsdSyntaxError);
  assert.throws(() => parse('1abc'), LsdSyntaxError);
});

test('parses sub-pipelines recursively', () => {
  const [map] = parse('map[trim split(" ") filter[.length]](1)');
  assert.equal(map.args, '1');
  assert.deepEqual(
    map.body.map((step) => step.name),
    ['trim', 'split', 'filter'],
  );
  assert.equal(map.body[2].body[0].type, 'prop');
});

test('keeps brackets inside sub-pipeline args', () => {
  const [map] = parse("map[split(']') first]");
  assert.equal(map.body[0].args, "']'");
});

test('parses library steps', () => {
  assert.deepEqual(parse('lodash::chunk(2) R::map[upper]').map(({ type, lib, name }) => [type, lib, name]), [
    ['lib', 'lodash', 'chunk'],
    ['lib', 'R', 'map'],
  ]);
});

test('reports positions inside sub-pipelines', () => {
  assert.throws(() => parse('map[trim #]'), (error) => error.pos === 9);
  assert.throws(() => parse('map[trim'), /unterminated sub-pipeline/);
  assert.throws(() => parse('map[a][b]'), /duplicate sub-pipeline/);
});
