import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, LsdSyntaxError } from '../src/lsd/index.js';
import { parseBody, parseObjectEntries, splitTop } from '../src/lsd/parse.js';

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
  const [prop, method] = parse('.a.b .c.d()');
  assert.deepEqual([prop.type, prop.path], ['prop', ['a', 'b']]);
  assert.deepEqual([method.type, method.path, method.name, method.args], ['method', ['c'], 'd', '']);
});

test('reports position on syntax errors', () => {
  assert.throws(() => parse('trim split(","'), (error) => error instanceof LsdSyntaxError && error.pos === 10);
  assert.throws(() => parse('trim#'), LsdSyntaxError);
  assert.throws(() => parse('1abc'), LsdSyntaxError);
});

test('keeps sub-pipelines as ranges, parsed by their consumer', () => {
  const spec = 'map[trim split(" ") filter[.length]](1)';
  const [map] = parse(spec);
  assert.equal(map.args, '1');
  assert.equal(spec.slice(map.body.from, map.body.to), 'trim split(" ") filter[.length]');
  const inner = parseBody(map.body);
  assert.deepEqual(
    inner.map((step) => step.name),
    ['trim', 'split', 'filter'],
  );
  assert.equal(parseBody(inner[2].body)[0].type, 'prop');
});

test('keeps brackets inside sub-pipeline args', () => {
  const [map] = parse("map[split(']') first]");
  assert.equal(parseBody(map.body)[0].args, "']'");
});

test('predicate bodies, objects, tuples and safe mode', () => {
  const [filter, object, tuple, safe] = parse('filter?[string] { a: .b } [.x, .y] ?');
  assert.equal(filter.body.predicate, true);
  assert.deepEqual([object.type, tuple.type, safe.type], ['object', 'tuple', 'safe']);
  assert.deepEqual(
    parseObjectEntries(object).map(({ key, steps }) => [key, steps.length]),
    [['a', 1]],
  );
});

test('object entries', () => {
  const entries = parseObjectEntries(parse("{ id, 'my key': .x, age?: number, ...pick }")[0]);
  assert.deepEqual(
    entries.map(({ key, optional, spread, steps }) => [key, optional, spread, steps?.length ?? null]),
    [
      ['id', false, false, null],
      ["'my key'", false, false, 1],
      ['age', true, false, 1],
      [undefined, undefined, true, 1],
    ],
  );
  assert.throws(() => parseObjectEntries(parse('{ a b }')[0]), /expected `key: spec`/);
});

test('splitTop ignores nested separators', () => {
  const source = "a(1, 2), [b, c], 'd, e' | f || g";
  const parts = splitTop(source, 0, source.length, ',').map(({ from, to }) => source.slice(from, to));
  assert.deepEqual(parts, ['a(1, 2)', '[b, c]', "'d, e' | f || g"]);
  const cases = splitTop(source, 0, source.length, '|').map(({ from, to }) => source.slice(from, to));
  assert.deepEqual(cases, ["a(1, 2), [b, c], 'd, e'", 'f || g']);
});

test('parses library steps', () => {
  assert.deepEqual(parse('lodash::chunk(2) R::map[upper]').map(({ type, lib, name }) => [type, lib, name]), [
    ['lib', 'lodash', 'chunk'],
    ['lib', 'R', 'map'],
  ]);
});

test('reports positions inside sub-pipelines', () => {
  assert.throws(() => parseBody(parse('map[trim #]')[0].body), (error) => error.pos === 9);
  assert.throws(() => parse('map[trim'), /unterminated sub-pipeline/);
  assert.throws(() => parse('map[a][b]'), /duplicate sub-pipeline/);
});
