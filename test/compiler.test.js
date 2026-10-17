import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, loadLibExports, LsdCompileError } from '../src/compiler/index.js';
import lsdPlugin from '../src/vite.js';
import lodashPreset from '../src/lsd/presets/lodash.js';

const src = (...lines) => lines.join('\n');

test('replaces static specs and drops the unused import', () => {
  const result = compile(
    src(
      "import { lsd } from 'wtf.js';",
      "const normalizeKey = lsd.fn('trim toLowerCase');",
      'const tag = lsd.fn(`upper`);',
    ),
  );
  assert.equal(result.compiled, 2);
  assert.equal(
    result.code,
    src('const normalizeKey = (it) => it.trim().toLowerCase();', 'const tag = (it) => it.toUpperCase();'),
  );
});

test('wraps the arrow where it would change the meaning', () => {
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", "a(lsd.fn('trim')); lsd.fn('trim')(x); b || lsd.fn('trim');"),
  );
  assert.equal(code, 'a((it) => it.trim()); ((it) => it.trim())(x); b || ((it) => it.trim());');
});

test('keeps the import while runtime calls remain', () => {
  const warnings = [];
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", 'const a = lsd.fn(spec);', "const b = lsd.fn('trim');"),
    { onWarn: (message) => warnings.push(message) },
  );
  assert.equal(
    code,
    src("import { lsd } from 'wtf.js';", 'const a = lsd.fn(spec);', 'const b = (it) => it.trim();'),
  );
  assert.equal(warnings.length, 1);
});

test('handles aliases and sibling specifiers', () => {
  const { code } = compile(src("import { str, lsd as l } from 'wtf.js';", "const f = l.fn('lower');"));
  assert.equal(code, src("import { str } from 'wtf.js';", 'const f = (it) => it.toLowerCase();'));
});

test('custom ops via options', () => {
  const { code } = compile(src("import { lsd } from 'wtf.js';", "const f = lsd.fn('trim shout');"), {
    ops: { shout: (x) => `${x}.toUpperCase() + '!'` },
  });
  assert.equal(code, "const f = (it) => it.trim().toUpperCase() + '!';");
});

test('generated code behaves like the runtime', async () => {
  const { lsd } = await import('../src/index.js');
  const spec = "split(',') .map((s) => s.trim()) compact unique";
  const { code } = compile(src("import { lsd } from 'wtf.js';", `export default lsd.fn("${spec}");`));
  const compiled = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
  assert.deepEqual(compiled(' a, b,,a '), lsd.fn(spec)(' a, b,,a '));
});

test('errors point at the call site', () => {
  assert.throws(
    () => compile(src("import { lsd } from 'wtf.js';", '', "const f = lsd.fn('or');"), { filename: 'x.js' }),
    (error) => error instanceof LsdCompileError && error.message.startsWith('x.js:3:11'),
  );
  assert.throws(() => compile(src("import { lsd } from 'wtf.js';", "lsd.fn('split(,)');")), /invalid code/);
});

test('ignores files without the import', () => {
  assert.equal(compile("const lsd = { fn() {} }; lsd.fn('trim');"), null);
  assert.equal(compile("import { str } from 'wtf.js';"), null);
});

test('vite plugin filters ids', async () => {
  const plugin = lsdPlugin();
  const code = src("import { lsd } from 'wtf.js';", "export const f = lsd.fn('trim');");
  assert.equal(await plugin.transform(code, '/app/node_modules/x/index.js'), null);
  assert.equal(await plugin.transform(code, '/app/style.css'), null);
  const result = await plugin.transform.call({ warn() {} }, code, '/app/src/a.js?v=1');
  assert.equal(result.code, 'export const f = (it) => it.trim();');
});

test('library steps become imports', () => {
  const { code } = compile(
    src(
      '#!/usr/bin/env node',
      "import { lsd } from 'wtf.js';",
      "const f = lsd.fn('trim lodash::kebabCase R::reverse _::kebabCase');",
      "const g = lsd.fn('chunk(2)');",
    ),
    { ops: lodashPreset },
  );
  assert.equal(
    code,
    src(
      '#!/usr/bin/env node',
      "import { kebabCase as __lsd_lodash_kebabCase, chunk as __lsd_lodash_chunk } from 'lodash-es';",
      "import { reverse as __lsd_ramda_reverse } from 'ramda';",
      'const f = (it) => __lsd_lodash_kebabCase(__lsd_ramda_reverse(__lsd_lodash_kebabCase(it.trim())));',
      'const g = (it) => __lsd_lodash_chunk(it, 2);',
    ),
  );
});

test('library locals avoid collisions and support per-function modules', () => {
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", 'const __lsd_lodash_chunk = 1;', "const f = lsd.fn('lodash::chunk(2)');"),
    { libs: { lodash: { module: (name) => `lodash/${name}.js`, named: false } } },
  );
  assert.equal(
    code,
    src(
      "import ___lsd_lodash_chunk from 'lodash/chunk.js';",
      'const __lsd_lodash_chunk = 1;',
      'const f = (it) => ___lsd_lodash_chunk(it, 2);',
    ),
  );
});

test('unknown libraries fail the build', () => {
  assert.throws(() => compile(src("import { lsd } from 'wtf.js';", "lsd.fn('nope::x');")), /unknown library 'nope'/);
});

test('compiled library code runs', async () => {
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", "export default lsd.fn('map[trim] lodash::uniq R::sortBy[lower]');"),
    { libs: { lodash: { module: import.meta.resolve('lodash-es') }, ramda: { module: import.meta.resolve('ramda') } } },
  );
  const compiled = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
  assert.deepEqual(compiled([' b', 'A ', 'b']), ['A', 'b']);
});

test('tagged templates capture values once, interpolations stay in place', () => {
  const { code } = compile(
    src(
      "import { lsd } from 'wtf.js';",
      'const f = lsd.fn`or(${fallback}) trim ${shout}`;',
      'const g = lsd.fn`replace(/\\s+/g, "-")`;',
      "const h = lsd.fn`map[${lsd.fn('trim')}]`;",
    ),
  );
  assert.equal(
    code,
    src(
      'const f = (($0, $1) => (it) => $1((it ?? $0).trim()))(fallback, shout);',
      'const g = (it) => it.replace(/\\s+/g, "-");',
      'const h = (($0) => (it) => it.map((it) => $0(it)))((it) => it.trim());',
    ),
  );
});

test('tagged template captures behave like the runtime', async () => {
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", 'let n = 1;', 'export default lsd.fn`map[(it + ${n})]`;', 'n = 5;'),
  );
  const compiled = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
  assert.deepEqual(compiled([1, 2]), [2, 3]);
});

test('expression steps and multi-param pipelines', () => {
  const { code } = compile(
    src(
      "import { lsd } from 'wtf.js';",
      "const px = lsd.fn('num (it + \\'px\\')');",
      "const total = lsd.fn('reduce[acc it => (acc + it.price)](0)');",
      "const add = lsd.fn('a b => (a + b)');",
    ),
  );
  assert.equal(
    code,
    src(
      "const px = (it) => { it = Number(it); return (it + 'px'); };",
      'const total = (it) => it.reduce((acc, it) => (acc + it.price), 0);',
      'const add = (a, b) => (a + b);',
    ),
  );
});

test('prefer resolves unknown names against library exports', async () => {
  const libExports = await loadLibExports(['lodash', 'R']);
  assert.ok(libExports.lodash.has('kebabCase'));
  assert.ok(libExports.ramda.has('take'));

  const { code } = compile(
    src("import { lsd } from 'wtf.js';", "const f = lsd.fn('kebabCase .trim() nope');"),
    { prefer: ['lodash'], libExports },
  );
  assert.equal(
    code,
    src(
      "import { kebabCase as __lsd_lodash_kebabCase } from 'lodash-es';",
      'const f = (it) => __lsd_lodash_kebabCase(it).trim().nope();',
    ),
  );
  assert.throws(
    () => compile(src("import { lsd } from 'wtf.js';", "lsd.fn('x');"), { prefer: ['lodash'] }),
    /exports of 'lodash' are unknown/,
  );
});

test('known exports catch typos', async () => {
  const libExports = await loadLibExports(['lodash']);
  assert.throws(
    () => compile(src("import { lsd } from 'wtf.js';", "lsd.fn('lodash::kebabcase');"), { libExports }),
    /not exported by 'lodash', did you mean 'kebabCase'\?/,
  );
  assert.throws(() => compile(src("import { lsd } from 'wtf.js';", "lsd.fn('lodahs::chunk');")), /did you mean 'lodash'/);
});

test('vite plugin loads exports for prefer and typo checks', async () => {
  const plugin = lsdPlugin({ prefer: ['lodash'] });
  const ctx = { warn() {}, error: (error) => { throw error; } };
  const result = await plugin.transform.call(ctx, src("import { lsd } from 'wtf.js';", "lsd.fn('camelCase');"), '/a.js');
  assert.match(result.code, /__lsd_lodash_camelCase\(it\)/);
  await assert.rejects(
    plugin.transform.call(ctx, src("import { lsd } from 'wtf.js';", "lsd.fn('_::camelcase');"), '/b.js'),
    /did you mean 'camelCase'/,
  );
});
