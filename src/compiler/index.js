// build-time compiler: replaces `lsd.fn('<static spec>')` with the generated function
// and drops the `lsd` import once nothing references it anymore.

import { parse as parseJs, parseExpressionAt } from 'acorn';
import { ancestor, full } from 'acorn-walk';
import MagicString from 'magic-string';
import { parse, LsdSyntaxError } from '../lsd/parse.js';
import { generate } from '../lsd/generate.js';
import { builtins, createVocabulary } from '../lsd/ops.js';
import { createAdapters, resolveAdapter } from '../lsd/libs.js';

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
};

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
  const { filename, ops, libs, module = 'wtf.js', sourcemap = true, onWarn = () => {} } = options;

  if (!source.includes(module)) return null;

  const ast = parseJs(source, ACORN);
  const imports = findImports(ast, module);
  if (!imports.length) return null;

  const locals = new Set(imports.map((entry) => entry.local));
  const vocabulary = createVocabulary(builtins, ops);
  const libImports = createLibImports(createAdapters(libs), ast);
  const out = new MagicString(source);
  let compiled = 0;

  ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      const local = matchFn(node, locals);
      if (!local) return;

      const spec = staticSpec(node.arguments);
      if (spec === null) {
        onWarn(
          `${filename ?? '<input>'}:${node.loc.start.line}: ${local}.fn() with a dynamic spec stays a runtime call`,
        );
        return;
      }

      let fnCode;
      try {
        fnCode = generate(parse(spec), { vocabulary, spec, lib: libImports.resolve });
        validate(fnCode);
      } catch (error) {
        throw new LsdCompileError(error.message, { filename, loc: node.loc.start, cause: error });
      }

      const parent = ancestors[ancestors.length - 2];
      const bare = BARE_ARROW_OK[parent?.type]?.(parent, node);
      out.overwrite(node.start, node.end, bare ? fnCode : `(${fnCode})`);
      compiled++;
      imports.find((entry) => entry.local === local).replaced++;
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

// collects `lib::name` steps and turns them into import declarations with collision-free locals
function createLibImports(adapters, ast) {
  const taken = new Set();
  full(ast, (node) => {
    if (node.type === 'Identifier') taken.add(node.name);
  });

  const entries = new Map();

  const resolve = (step, ctx) => {
    const resolved = resolveAdapter(adapters, step.lib);
    if (!resolved) {
      throw new LsdSyntaxError(`unknown library '${step.lib}', configure it via the 'libs' option`, ctx.spec, step.start);
    }
    const { key, adapter } = resolved;
    if (!adapter.module) {
      throw new LsdSyntaxError(`library '${key}' has no module configured`, ctx.spec, step.start);
    }

    const specifier = typeof adapter.module === 'function' ? adapter.module(step.name) : adapter.module;
    const id = `${specifier}#${adapter.named ? step.name : 'default'}`;
    let entry = entries.get(id);
    if (!entry) {
      let local = `__lsd_${key}_${step.name}`;
      while (taken.has(local)) local = `_${local}`;
      taken.add(local);
      entry = { specifier, name: step.name, named: adapter.named, local };
      entries.set(id, entry);
    }
    return { ref: entry.local, adapter };
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
function matchFn(node, locals) {
  const { callee } = node;
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
