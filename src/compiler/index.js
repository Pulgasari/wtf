// build-time compiler: replaces `lsd.fn('<static spec>')` with the generated function
// and drops the `lsd` import once nothing references it anymore.

import { parse as parseJs, parseExpressionAt } from 'acorn';
import { ancestor, full } from 'acorn-walk';
import MagicString from 'magic-string';
import { parse, joinTemplate, LsdSyntaxError } from '../lsd/parse.js';
import { generate } from '../lsd/generate.js';
import { builtins, createVocabulary } from '../lsd/ops.js';
import { createAdapters, resolveAdapter, didYouMean } from '../lsd/libs.js';

export { loadLibExports } from './exports.js';

const ACORN = { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true };

// parents in which an arrow function can stand without parens
const BARE_ARROW_OK = {
  VariableDeclarator: (parent, node) => parent.init === node,
  AssignmentExpression: (parent, node) => parent.right === node,
  AssignmentPattern: (parent, node) => parent.right === node,
  Property: (parent, node) => parent.value === node,
  PropertyDefinition: (parent, node) => parent.value === node,
  CallExpression: (parent, node) => parent.callee !== node,
  NewExpression: (parent, node) => parent.callee !== node,
  ArrayExpression: () => true,
  ReturnStatement: () => true,
  ExportDefaultDeclaration: () => true,
  ArrowFunctionExpression: (parent, node) => parent.body === node,
  ConditionalExpression: (parent, node) => parent.test !== node,
  ExpressionStatement: () => true,
  TemplateLiteral: () => true,
};

// parens around the arrow only where its position needs them
function wrap(fnCode, node, ancestors) {
  const parent = ancestors[ancestors.length - 2];
  return BARE_ARROW_OK[parent?.type]?.(parent, node) ? fnCode : `(${fnCode})`;
}

export class LsdCompileError extends Error {
  constructor(message, { filename, loc, cause } = {}) {
    const where = loc ? `${filename ?? '<input>'}:${loc.line}:${loc.column + 1}` : filename;
    super(where ? `${where}: ${message}` : message, { cause });
    this.name = 'LsdCompileError';
    this.filename = filename;
    this.loc = loc;
  }
}

/**
 * @returns {{ code: string, map: object | null, compiled: number } | null}
 *   null if the source does not import `lsd` from `module`.
 */
export function compile(source, options = {}) {
  const {
    filename,
    ops,
    libs,
    prefer = [],
    libExports = {},
    module = 'wtf.js',
    sourcemap = true,
    onWarn = () => {},
  } = options;

  if (!source.includes(module)) return null;

  const ast = parseJs(source, ACORN);
  const imports = findImports(ast, module);
  if (!imports.length) return null;

  const locals = new Set(imports.map((entry) => entry.local));
  const vocabulary = createVocabulary(builtins, ops);
  const libImports = createLibImports(createAdapters(libs), ast, { prefer, libExports });
  const out = new MagicString(source);
  let compiled = 0;

  const build = (node, spec, captures) => {
    try {
      const fnCode = generate(parse(spec), {
        vocabulary,
        spec,
        captures,
        lib: libImports.resolve,
        implicit: libImports.implicit,
      });
      validate(fnCode);
      return fnCode;
    } catch (error) {
      throw new LsdCompileError(error.message, { filename, loc: node.loc.start, cause: error });
    }
  };

  const done = (local) => {
    compiled++;
    imports.find((entry) => entry.local === local).replaced++;
  };

  ancestor(ast, {
    // lsd.fn`spec ${value}` -> (($0) => fn)(value), captures are evaluated once, like at runtime
    TaggedTemplateExpression(node, _state, ancestors) {
      const local = matchFn(node.tag, locals);
      if (!local) return;

      const { quasis, expressions } = node.quasi;
      const fnCode = build(node, joinTemplate(quasis.map((quasi) => quasi.value.raw)), expressions.length);

      if (!expressions.length) {
        out.overwrite(node.start, node.end, wrap(fnCode, node, ancestors));
      } else {
        // keep the interpolated expressions in place (they may contain compiled calls themselves)
        const names = expressions.map((_, index) => `$${index}`).join(', ');
        out.overwrite(node.start, expressions[0].start, `((${names}) => ${fnCode})(`);
        expressions.slice(1).forEach((expression, index) => {
          out.overwrite(expressions[index].end, expression.start, ', ');
        });
        out.overwrite(expressions.at(-1).end, node.end, ')');
      }
      done(local);
    },

    CallExpression(node, _state, ancestors) {
      const local = matchFn(node.callee, locals);
      if (!local) return;

      const spec = staticSpec(node.arguments);
      if (spec === null) {
        onWarn(
          `${filename ?? '<input>'}:${node.loc.start.line}: ${local}.fn() with a dynamic spec stays a runtime call`,
        );
        return;
      }

      const fnCode = build(node, spec, 0);
      out.overwrite(node.start, node.end, wrap(fnCode, node, ancestors));
      done(local);
    },
  });

  if (!compiled) return null;

  removeUnusedImports(ast, imports, out);
  if (libImports.size) {
    // after a hashbang line, otherwise at the very top
    const at = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
    if (at > 0) out.appendLeft(at, libImports.code());
    else out.prepend(libImports.code());
  }

  return {
    code: out.toString(),
    map: sourcemap ? out.generateMap({ source: filename, includeContent: true, hires: true }) : null,
    compiled,
  };
}

// collects `lib::name` steps and turns them into import declarations with collision-free locals.
// with known exports (libExports) it checks names and resolves `prefer` lookups.
function createLibImports(adapters, ast, { prefer, libExports }) {
  const taken = new Set();
  full(ast, (node) => {
    if (node.type === 'Identifier') taken.add(node.name);
  });

  const preferred = prefer.map((name) => {
    const resolved = resolveAdapter(adapters, name);
    if (!resolved) throw new LsdCompileError(`prefer: unknown library '${name}'`);
    const known = libExports[resolved.key];
    if (!known) {
      throw new LsdCompileError(
        `prefer: exports of '${resolved.key}' are unknown, pass them via 'libExports' (see loadLibExports) or use the vite plugin`,
      );
    }
    return { ...resolved, known };
  });

  const entries = new Map();

  const entryFor = (key, adapter, name) => {
    const specifier = typeof adapter.module === 'function' ? adapter.module(name) : adapter.module;
    const id = `${specifier}#${adapter.named ? name : 'default'}`;
    let entry = entries.get(id);
    if (!entry) {
      let local = `__lsd_${key}_${name}`;
      while (taken.has(local)) local = `_${local}`;
      taken.add(local);
      entry = { specifier, name, named: adapter.named, local };
      entries.set(id, entry);
    }
    return { ref: entry.local, adapter };
  };

  const resolve = (step, ctx) => {
    const fail = (message) => {
      throw new LsdSyntaxError(message, ctx.spec, step.start);
    };
    const resolved = resolveAdapter(adapters, step.lib);
    if (!resolved) {
      const known = Object.keys(adapters);
      fail(`unknown library '${step.lib}'${didYouMean(step.lib, known)}, configure it via the 'libs' option`);
    }
    const { key, adapter } = resolved;
    if (!adapter.module) fail(`library '${key}' has no module configured`);
    const known = libExports[key];
    if (known && !known.has(step.name)) {
      fail(`'${step.name}' is not exported by '${key}'${didYouMean(step.name, known)}`);
    }
    return entryFor(key, adapter, step.name);
  };

  const implicit = (step) => {
    for (const { key, adapter, known } of preferred) {
      if (known.has(step.name)) return entryFor(key, adapter, step.name);
    }
    return null;
  };

  // one declaration per module: `import { a as __lsd_x_a, b as __lsd_x_b } from 'x';`
  const code = () => {
    const named = new Map();
    const defaults = [];
    for (const { specifier, name, named: isNamed, local } of entries.values()) {
      if (!isNamed) defaults.push(`import ${local} from ${quote(specifier)};`);
      else named.set(specifier, [...(named.get(specifier) ?? []), `${name} as ${local}`]);
    }
    const declarations = [...named].map(([specifier, list]) => `import { ${list.join(', ')} } from ${quote(specifier)};`);
    return `${[...declarations, ...defaults].join('\n')}\n`;
  };

  return {
    resolve,
    implicit,
    code,
    get size() {
      return entries.size;
    },
  };
}

const quote = (value) => `'${value.replace(/[\\']/g, '\\$&')}'`;

// `import { lsd } from 'wtf.js'` and `import { lsd as x } from 'wtf.js'`
function findImports(ast, module) {
  const found = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== module) continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && importedName(spec) === 'lsd') {
        found.push({ declaration: node, specifier: spec, local: spec.local.name, replaced: 0 });
      }
    }
  }
  return found;
}

function importedName(spec) {
  return spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
}

// `<local>.fn(...)`, returns the matched local name
function matchFn(callee, locals) {
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) return null;
  if (callee.object.type !== 'Identifier' || !locals.has(callee.object.name)) return null;
  if (callee.property.type !== 'Identifier' || callee.property.name !== 'fn') return null;
  return callee.object.name;
}

// string literal or template literal without expressions, otherwise null
function staticSpec(args) {
  if (args.length !== 1) return null;
  const [arg] = args;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && !arg.expressions.length) return arg.quasis[0].value.cooked;
  return null;
}

// args are injected verbatim, so make sure the result is still valid javascript
function validate(fnCode) {
  try {
    const node = parseExpressionAt(fnCode, 0, { ecmaVersion: 'latest' });
    if (node.end !== fnCode.length) throw new Error(`unexpected input at ${node.end}`);
  } catch (error) {
    throw new Error(`generated invalid code (check the args in your spec): ${fnCode}\n  ${error.message}`);
  }
}

// an import is unused if every reference to its local name was a replaced call.
// counting identifiers by name ignores scopes, so shadowing only ever keeps an import, never drops a used one.
function removeUnusedImports(ast, imports, out) {
  const references = new Map(imports.map((entry) => [entry.local, 0]));
  for (const statement of ast.body) {
    if (statement.type === 'ImportDeclaration') continue;
    full(statement, (node) => {
      if (node.type === 'Identifier' && references.has(node.name)) {
        references.set(node.name, references.get(node.name) + 1);
      }
    });
  }

  const removable = imports.filter((entry) => references.get(entry.local) === entry.replaced);
  const byDeclaration = groupBy(removable, (entry) => entry.declaration);

  for (const [declaration, entries] of byDeclaration) {
    const { specifiers } = declaration;
    if (entries.length === specifiers.length) {
      // nothing left from this declaration, wtf.js has no side effects worth keeping
      let end = declaration.end;
      if (out.original[end] === '\n') end++;
      out.remove(declaration.start, end);
      continue;
    }
    for (const { specifier } of entries) {
      const index = specifiers.indexOf(specifier);
      const next = specifiers[index + 1];
      const prev = specifiers[index - 1];
      if (next) out.remove(specifier.start, next.start);
      else out.remove(prev.end, specifier.end);
    }
  }
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}
