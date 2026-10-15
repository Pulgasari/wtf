import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, LsdCompileError } from '../src/compiler/index.js';
import lsdPlugin from '../src/vite.js';

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
    src('const normalizeKey = (v) => v.trim().toLowerCase();', 'const tag = (v) => v.toUpperCase();'),
  );
});

test('wraps the arrow where it would change the meaning', () => {
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", "a(lsd.fn('trim')); lsd.fn('trim')(x); b || lsd.fn('trim');"),
  );
  assert.equal(code, 'a((v) => v.trim()); ((v) => v.trim())(x); b || ((v) => v.trim());');
});

test('keeps the import while runtime calls remain', () => {
  const warnings = [];
  const { code } = compile(
    src("import { lsd } from 'wtf.js';", 'const a = lsd.fn(spec);', "const b = lsd.fn('trim');"),
    { onWarn: (message) => warnings.push(message) },
  );
  assert.equal(
    code,
    src("import { lsd } from 'wtf.js';", 'const a = lsd.fn(spec);', 'const b = (v) => v.trim();'),
  );
  assert.equal(warnings.length, 1);
});

test('handles aliases and sibling specifiers', () => {
  const { code } = compile(src("import { str, lsd as l } from 'wtf.js';", "const f = l.fn('lower');"));
  assert.equal(code, src("import { str } from 'wtf.js';", 'const f = (v) => v.toLowerCase();'));
});

test('custom ops via options', () => {
  const { code } = compile(src("import { lsd } from 'wtf.js';", "const f = lsd.fn('trim shout');"), {
    ops: { shout: (x) => `${x}.toUpperCase() + '!'` },
  });
  assert.equal(code, "const f = (v) => v.trim().toUpperCase() + '!';");
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

test('vite plugin filters ids', () => {
  const plugin = lsdPlugin();
  const code = src("import { lsd } from 'wtf.js';", "export const f = lsd.fn('trim');");
  assert.equal(plugin.transform(code, '/app/node_modules/x/index.js'), null);
  assert.equal(plugin.transform(code, '/app/style.css'), null);
  assert.equal(plugin.transform.call({ warn() {} }, code, '/app/src/a.js?v=1').code, 'export const f = (v) => v.trim();');
});
