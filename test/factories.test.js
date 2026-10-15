import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lsd } from '../src/index.js';
import { compile } from '../src/compiler/index.js';

const src = (...lines) => lines.join('\n');

// compiles `export default <expression>` and imports the result
async function built(expression, options) {
  const { code } = compile(src("import { lsd } from 'wtf.js';", `export default ${expression};`), options);
  return (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
}

const people = [
  { name: 'bo', age: 30, tags: ['x'] },
  { name: 'Al', age: 30, tags: [] },
  { name: 'cy', age: 12, tags: ['y', 'z'] },
];

test('object and tuple builders', () => {
  assert.equal(
    lsd.code('{ id: .id int, name: .name trim, tags, ... }'),
    '(it) => ({ id: Number.parseInt(it.id, 10), name: it.name.trim(), tags: it.tags, ...it })',
  );
  assert.deepEqual(lsd.fn("{ 'full name': .name upper, n: .tags.length }")(people[0]), { 'full name': 'BO', n: 1 });
  assert.deepEqual(lsd.fn('map[.age] [(Math.min(...it)), (Math.max(...it))]')(people), [12, 30]);
  assert.deepEqual(lsd.fn('[.name, .age]')(people[2]), ['cy', 12]);
  // the current value is bound once before building
  assert.equal(lsd.code('trim [lower, upper]'), '(it) => { const _0 = it.trim(); return [_0.toLowerCase(), _0.toUpperCase()]; }');
});

test('safe mode', () => {
  const name = lsd.fn('? .user.profile.name trim');
  assert.equal(name({}), undefined);
  assert.equal(name({ user: { profile: { name: ' x ' } } }), 'x');
  assert.equal(lsd.code('.a ? .b.c'), '(it) => it.a?.b?.c');
});

test('lsd.is', () => {
  const valid = lsd.is('{ name: string filled, age?: integer gte(0), tags: array[string] }');
  assert.equal(valid(people[0]), true);
  assert.equal(valid({ name: '', tags: [] }), false);
  assert.equal(valid({ name: 'x', age: -1, tags: [] }), false);
  assert.equal(valid({ name: 'x', tags: [1] }), false);
  assert.equal(valid(null), false);

  assert.equal(lsd.is('string filled or nil')(null), true);
  assert.equal(lsd.is('not [string or number]')(true), true);
  assert.equal(lsd.is('[string, number]')(['a', 1]), true);
  assert.equal(lsd.is('.user.name[string minLen(2)] .active')({ user: { name: 'ab' }, active: 1 }), true);
  assert.equal(lsd.is('.user.name[string minLen(2)]')({}), false);
  assert.equal(lsd.is('email')('a@b.de'), true);
  assert.equal(lsd.is('between(1, 3) odd')(3), true);
  assert.equal(lsd.is("oneOf('a', 'b')")('c'), false);
  assert.equal(lsd.is('(it % 3 === 0)')(9), true);
  assert.equal(lsd.is('.has("x")')(new Set(['x'])), true);
  assert.equal(lsd.is('')(1), true);
  assert.throws(() => lsd.is('strng'), /did you mean 'string'/);
  assert.throws(() => lsd.is('string or'), /empty 'or' branch/);
  assert.throws(() => lsd.is('string not'), /dangling 'not'/);
});

test('custom checks', () => {
  lsd.is.define({ adult: '.age[gte(18)]', even10: (x) => `${x} % 10 === 0` });
  assert.equal(lsd.is('adult')(people[0]), true);
  assert.equal(lsd.is('not adult')(people[2]), true);
  assert.equal(lsd.is('even10')(20), true);
});

test('predicate callbacks', () => {
  assert.deepEqual(lsd.fn('filter?[.tags[array filled]] map[.name]')(people), ['bo', 'cy']);
  assert.equal(lsd.fn('some?[.age[lt(18)]]')(people), true);
  assert.equal(lsd.fn('.tags is[array filled]')(people[1]), false);
});

test('lsd.cmp and order', () => {
  const sorted = people.toSorted(lsd.cmp('.age desc, .name lower'));
  assert.deepEqual(sorted.map((p) => p.name), ['Al', 'bo', 'cy']);
  assert.deepEqual(['b10', 'b9', 'a'].sort(lsd.cmp('natural')), ['a', 'b9', 'b10']);
  assert.deepEqual([3, 1, 2].sort(lsd.cmp('')), [1, 2, 3]);
  assert.deepEqual(lsd.fn('order[.age, .name desc] map[.name]')(people), ['cy', 'bo', 'Al']);
  assert.equal(
    lsd.code('.age desc, .name', 'cmp'),
    '(a, b) => { const _0 = (x, y) => (x < y ? -1 : x > y ? 1 : 0); return _0(b.age, a.age) || _0(a.name, b.name); }',
  );
});

test('lsd.match and when', () => {
  const describe = lsd.match('string -> trim upper | number -> (it * 2) | array -> .length | _ -> json');
  assert.equal(describe(' a '), 'A');
  assert.equal(describe(4), 8);
  assert.equal(describe([1, 2]), 2);
  assert.equal(describe({ a: 1 }), '{"a":1}');
  assert.equal(lsd.match('string -> trim')(1), undefined);
  assert.deepEqual(lsd.fn('map[when[.age[gte(18)] -> .name upper | _ -> (null)]] compact')(people), ['BO', 'AL']);
  assert.throws(() => lsd.match('_ -> str | string -> trim'), /must be the last/);
  assert.throws(() => lsd.match('string trim'), /checks -> pipeline/);
});

test('lsd.fmt', () => {
  const card = lsd.fmt('{.name capitalize} ({.age}) {{tags: {.tags json}}}');
  assert.equal(card(people[0]), 'Bo (30) {tags: ["x"]}');
  assert.equal(lsd.fmt('`{}` costs ${{}}')(5), '`5` costs ${}');
  const unit = 'px';
  assert.equal(lsd.fmt`{.w}${unit} x {.h}${unit}`({ w: 1, h: 2 }), '1px x 2px');
  assert.deepEqual(lsd.fn('map[fmt[{.name}: {.age}]]')(people.slice(0, 1)), ['bo: 30']);
});

test('lsd.$ proxy chains', () => {
  assert.equal(lsd.$.trim.toUpperCase(' hi '), 'HI');
  assert.equal(lsd.$(5), 5);
  assert.equal(lsd.$.trim.then, undefined);
});

test('compiler: every factory, chains and tagged templates', () => {
  const { code } = compile(
    src(
      "import { lsd } from 'wtf.js';",
      "const a = lsd.is('string filled');",
      "const b = lsd.cmp('.age desc');",
      "const c = lsd.match('number -> (it * 2) | _ -> str');",
      "const d = lsd.fmt('hi {.name}');",
      'const e = lsd.$.trim.lower;',
      'const f = lsd.$.trim(x);',
      'const g = lsd.is`oneOf(${a}, ${b})`;',
    ),
  );
  assert.equal(
    code,
    src(
      "const a = (it) => { const _0 = (v) => v == null || (typeof v === 'string' || Array.isArray(v) ? v.length === 0 : v instanceof Map || v instanceof Set ? v.size === 0 : typeof v === 'object' ? Object.keys(v).length === 0 : false); return ((typeof it === 'string') && !(_0(it))); };",
      'const b = (a, b) => { const _0 = (x, y) => (x < y ? -1 : x > y ? 1 : 0); return _0(b.age, a.age); };',
      "const c = (it) => ((typeof it === 'number' && !Number.isNaN(it)) ? (it * 2) : String(it));",
      'const d = (it) => `hi ${it.name}`;',
      'const e = (it) => it.trim().toLowerCase();',
      'const f = ((it) => it.trim())(x);',
      'const g = (($0, $1) => (it) => ([$0, $1].includes(it)))(a, b);',
    ),
  );
});

test('compiled factories behave like the runtime', async () => {
  const cases = [
    ["lsd.is('{ name: string filled, age?: integer gte(0), tags: array[string] }')", [people[0], { name: '' }, null]],
    ["lsd.match('string -> trim upper | number -> (it * 2) | _ -> json')", [' a ', 4, { a: 1 }]],
    ["lsd.fmt('{.name capitalize} ({.age})')", [people[0]]],
    ["lsd.fn('filter?[.tags[array filled]] order[.age desc, .name natural] map[{ n: .name, a: .age }]')", [people]],
    ['lsd.$.trim.toUpperCase', [' x ']],
  ];
  for (const [expression, inputs] of cases) {
    const compiled = await built(expression);
    const runtime = new Function('lsd', `return ${expression}`)(lsd);
    for (const input of inputs) assert.deepEqual(compiled(input), runtime(input), `${expression} with ${JSON.stringify(input)}`);
  }
  const sorter = await built("lsd.cmp('.age desc, .name lower')");
  assert.deepEqual(people.toSorted(sorter), people.toSorted(lsd.cmp('.age desc, .name lower')));
});

test('compiler: custom predicates via options', () => {
  const { code } = compile(src("import { lsd } from 'wtf.js';", "const f = lsd.is('adult');"), {
    predicates: { adult: '.age[gte(18)]' },
  });
  assert.equal(code, 'const f = (it) => (it?.age >= (18));');
});

test('lsd.guess finds the cheapest pipeline', () => {
  assert.equal(lsd.guess.spec({ '  Foo ': 'foo', BAR: 'bar' }), 'trim lower');
  assert.equal(lsd.guess.spec([[[3, 1, 3], [1, 3]], [[2, 2], [2]]]), 'unique sortBy');
  assert.equal(lsd.guess.spec([[' a b ', 2]]), 'words .length');
  assert.equal(lsd.guess({ ' X ': 'x' })(' Hello '), 'hello');
  assert.equal(
    lsd.guess.spec([[' x,y ,z', ['X', 'Y', 'Z']]], { hints: ["split(',')", 'map[trim]'] }),
    "upper split(',') map[trim]",
  );
  assert.throws(() => lsd.guess({ a: 'zzz' }), /no pipeline found/);
});

test('compiler: lsd.guess runs at build time', () => {
  const { code } = compile(
    src(
      "import { lsd } from 'wtf.js';",
      "const a = lsd.guess({ '  Foo ': 'foo', BAR: 'bar' });",
      "const b = lsd.guess([[' a,b', ['a', 'b']]], { hints: [\"split(',')\"] });",
      'const c = lsd.guess(examples);',
    ),
    { onWarn() {} },
  );
  assert.equal(
    code,
    src(
      "import { lsd } from 'wtf.js';",
      'const a = /* lsd: trim lower */ (it) => it.trim().toLowerCase();',
      "const b = /* lsd: trim split(',') */ (it) => it.trim().split(',');",
      'const c = lsd.guess(examples);',
    ),
  );
  assert.throws(() => compile(src("import { lsd } from 'wtf.js';", "lsd.guess({ a: 'zzz' });")), /no pipeline found/);
});

test('lsd.parse is the inverse of fmt', () => {
  const person = lsd.parse('{name} ({age int})');
  assert.deepEqual(person('bo (30)'), { name: 'bo', age: 30 });
  assert.equal(person('nope'), null);
  // numeric groups keep adjacent fields apart
  assert.deepEqual(lsd.parse('{a}{b int}')('x12'), { a: 'x', b: 12 });
  // {} and {_} skip text, pipelines run on the captured string
  assert.deepEqual(lsd.parse("{_}: {tags split(',') map[trim]} [{}]")('k: a, b [z]'), { tags: ['a', 'b'] });
  assert.deepEqual(lsd.parse('{{{key}}}')('{x}'), { key: 'x' });
  assert.throws(() => lsd.parse('{a} {a}'), /duplicate field 'a'/);
  // round trip
  const fmt = lsd.fmt('{.name} ({.age})');
  assert.deepEqual(person(fmt({ name: 'al', age: 7 })), { name: 'al', age: 7 });
});

test('lsd.check reports paths', () => {
  const check = lsd.check(
    '{ name: string filled, age?: integer gte(0), tags: array[string], meta: { id }, role: string or nil }',
  );
  assert.deepEqual(check({ name: '', age: -1, tags: ['a', 2], meta: {}, role: 3 }), [
    { path: 'name', expected: 'filled' },
    { path: 'age', expected: 'gte(0)' },
    { path: 'tags[1]', expected: 'string' },
    { path: 'meta.id', expected: 'defined' },
    { path: 'role', expected: 'string or nil' },
  ]);
  assert.deepEqual(check({ name: 'x', tags: [], meta: { id: 1 } }), []);
  assert.deepEqual(check(null), [{ path: '', expected: 'object' }]);
  assert.deepEqual(lsd.check('[string, number]')(['a', 'b']), [{ path: '[1]', expected: 'number' }]);
  assert.deepEqual(lsd.check('not nil')(null), [{ path: '', expected: 'not nil' }]);
  assert.deepEqual(lsd.check('.user.name[string]')({}), [{ path: 'user.name', expected: 'string' }]);
  // macros report their own name
  lsd.is.define('adult', '.age[gte(18)]');
  assert.deepEqual(lsd.check('{ p: adult }')({ p: { age: 3 } }), [{ path: 'p', expected: 'adult' }]);
});

test('lsd.explain', () => {
  assert.deepEqual(lsd.explain('trim lower { a: .length }'), {
    code: '(it) => { const _0 = it.trim().toLowerCase(); return ({ a: _0.length }); }',
    steps: [
      { step: 'trim', expr: 'it.trim()' },
      { step: 'lower', expr: 'it.trim().toLowerCase()' },
      { step: '{ a: .length }', expr: '({ a: _0.length })' },
    ],
  });
});

test('compiler: parse and check', async () => {
  const parse = await built("lsd.parse('{name} ({age int})')");
  assert.deepEqual(parse('bo (30)'), { name: 'bo', age: 30 });
  const check = await built("lsd.check('{ tags: array[string] }')");
  assert.deepEqual(check({ tags: [1] }), [{ path: 'tags[0]', expected: 'string' }]);
});
