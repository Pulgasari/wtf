// build-time compiler: replaces `lsd.fn('<static spec>')` with the generated function
// and drops the `lsd` import once nothing references it anymore.

import { parse as parseJs, parseExpressionAt } from 'acorn';
import { ancestor, full } from 'acorn-walk';
import MagicString from 'magic-string';
import { joinTemplate, LsdSyntaxError } from '../lsd/parse.js';
import { generateKind, KINDS } from '../lsd/generate.js';
import { builtins, createVocabularyOf } from '../lsd/ops.js';
import { predicates as builtinPredicates } from '../lsd/predicates.js';
import { guess } from '../lsd/guess.js';
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
    predicates,
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
  const vocabulary = createVocabularyOf('fn', [builtins, ops]);
  const checks = createVocabularyOf('is', [builtinPredicates, predicates]);
  const libImports = createLibImports(createAdapters(libs), ast, { prefer, libExports });
  const out = new MagicString(source);
  let compiled = 0;

  const build = (node, kind, spec, captures) => {
    try {
      const fnCode = generateKind(kind, spec, {
        vocabulary,
        predicates: checks,
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

  // single steps for lsd.guess, evaluated at build time
  const buildStep = (spec) =>
    new Function('$libs', `return ${generateKind('fn', spec, { vocabulary, predicates: checks })}`)({});

  const done = (local) => {
    compiled++;
    imports.find((entry) => entry.local === local).replaced++;
  };

  ancestor(ast, {
    // lsd.fn`spec ${value}` -> (($0) => fn)(value), captures are evaluated once, like at runtime
    TaggedTemplateExpression(node, _state, ancestors) {
      const match = matchFactory(node.tag, locals);
      if (!match) return;
      const { local, kind } = match;

      const { quasis, expressions } = node.quasi;
      const raw = quasis.map((quasi) => quasi.value.raw);
      const fnCode = build(node, kind, joinTemplate(raw, kind), expressions.length);

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
      if (matchGuess(node.callee, locals)) {
        const local = node.callee.object.name;
        const [examples, options = {}] = node.arguments.map(staticValue);
        if (examples === NOT_STATIC || options === NOT_STATIC || node.arguments.length > 2) {
          onWarn(`${filename ?? '<input>'}:${node.loc.start.line}: ${local}.guess() with dynamic examples stays a runtime call`);
          return;
        }
        let spec;
        try {
          spec = guess(examples, buildStep, options);
        } catch (error) {
          throw new LsdCompileError(error.message, { filename, loc: node.loc.start, cause: error });
        }
        if (spec === null) {
          throw new LsdCompileError('lsd.guess: no pipeline found for these examples', { filename, loc: node.loc.start });
        }
        const fnCode = `/* lsd: ${spec.replace(/\*\//g, '* /')} */ ${build(node, 'fn', spec, 0)}`;
        out.overwrite(node.start, node.end, wrap(fnCode, node, ancestors));
        done(local);
        return;
      }

      const match = matchFactory(node.callee, locals);
      if (!match) return;
      const { local, kind } = match;

      const spec = staticSpec(node.arguments);
      if (spec === null) {
        onWarn(
          `${filename ?? '<input>'}:${node.loc.start.line}: ${local}.${kind}() with a dynamic spec stays a runtime call`,
        );
        return;
      }

      const fnCode = build(node, kind, spec, 0);
      out.overwrite(node.start, node.end, wrap(fnCode, node, ancestors));
      done(local);
    },

    // lsd.$.trim.lower -> fn('trim lower'), only the outermost member of a chain
    MemberExpression(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === 'MemberExpression' && parent.object === node && !parent.computed) return;
      const chain = matchChain(node, locals);
      if (!chain) return;
      const fnCode = build(node, 'fn', chain.steps.join(' '), 0);
      out.overwrite(node.start, node.end, wrap(fnCode, node, ancestors));
      done(chain.local);
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

  const resolve = (step) => {
    const fail = (message) => {
      throw new LsdSyntaxError(message, step.source, step.start);
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

// `<local>.fn`, `<local>.is`, ... -> { local, kind }
function matchFactory(callee, locals) {
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) return null;
  if (callee.object.type !== 'Identifier' || !locals.has(callee.object.name)) return null;
  if (callee.property.type !== 'Identifier' || !KINDS.includes(callee.property.name)) return null;
  return { local: callee.object.name, kind: callee.property.name };
}

// `<local>.guess`, the search runs at build time (lsd.guess({ ' A ': 'a' }) -> spec 'trim lower')
function matchGuess(callee, locals) {
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    locals.has(callee.object.name) &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'guess'
  );
}

const NOT_STATIC = Symbol('not static');

// evaluates literal-only expressions (objects, arrays, strings, numbers, booleans, null, negation)
function staticValue(node) {
  switch (node.type) {
    case 'Literal':
      return node.regex ? NOT_STATIC : node.value;
    case 'TemplateLiteral':
      return node.expressions.length ? NOT_STATIC : node.quasis[0].value.cooked;
    case 'UnaryExpression': {
      const value = node.operator === '-' || node.operator === '!' ? staticValue(node.argument) : NOT_STATIC;
      if (value === NOT_STATIC) return value;
      return node.operator === '-' ? -value : !value;
    }
    case 'ArrayExpression': {
      const items = node.elements.map((element) => (element && element.type !== 'SpreadElement' ? staticValue(element) : NOT_STATIC));
      return items.includes(NOT_STATIC) ? NOT_STATIC : items;
    }
    case 'ObjectExpression': {
      const result = {};
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init') return NOT_STATIC;
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
        const value = staticValue(property.value);
        if (value === NOT_STATIC) return NOT_STATIC;
        result[key] = value;
      }
      return result;
    }
    default:
      return NOT_STATIC;
  }
}

// `<local>.$.a.b.c` -> { local, steps: ['a', 'b', 'c'] }
function matchChain(node, locals) {
  const steps = [];
  let current = node;
  while (current.type === 'MemberExpression' && !current.computed && !current.optional) {
    steps.unshift(current.property.name);
    current = current.object;
  }
  if (current.type !== 'Identifier' || !locals.has(current.name) || steps[0] !== '$') return null;
  return { local: current.name, steps: steps.slice(1) };
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
