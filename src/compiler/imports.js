// import handling for the compiler: the `lsd` import itself and generated library imports.

import { LsdSyntaxError } from '../lsd/parse.js';
import { resolveAdapter, didYouMean } from '../lsd/libs.js';
import { LsdCompileError } from './errors.js';

// `import { lsd } from 'wtf.js'` and `import { lsd as x } from 'wtf.js'`
export function findLsdImports(ast, module) {
  const found = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== module) continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' && importedName(specifier) === 'lsd') {
        found.push({ declaration: node, specifier, local: specifier.local.name, replaced: 0 });
      }
    }
  }
  return found;
}

const importedName = (specifier) =>
  specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;

// local names of every import, generated locals must not collide with them either
export function importedLocals(ast) {
  return ast.body.flatMap((node) => (node.type === 'ImportDeclaration' ? node.specifiers.map((s) => s.local.name) : []));
}

// an import is unused if every reference to its local name was a replaced call.
// counting identifiers by name ignores scopes, so shadowing only ever keeps an import, never drops a used one.
export function removeUnusedImports(imports, counts, out) {
  const byDeclaration = new Map();
  for (const entry of imports) {
    if ((counts.get(entry.local) ?? 0) !== entry.replaced) continue;
    byDeclaration.set(entry.declaration, [...(byDeclaration.get(entry.declaration) ?? []), entry]);
  }

  for (const [declaration, entries] of byDeclaration) {
    const { specifiers } = declaration;
    if (entries.length === specifiers.length) {
      // nothing left from this declaration, wtf.js has no side effects worth keeping
      const end = out.original[declaration.end] === '\n' ? declaration.end + 1 : declaration.end;
      out.remove(declaration.start, end);
      continue;
    }
    for (const { specifier } of entries) {
      const index = specifiers.indexOf(specifier);
      const next = specifiers[index + 1];
      if (next) out.remove(specifier.start, next.start);
      else out.remove(specifiers[index - 1].end, specifier.end);
    }
  }
}

// collects `lib::name` steps and turns them into import declarations with collision-free locals.
// with known exports (libExports) it checks names and resolves `prefer` lookups.
export function createLibImports(adapters, taken, { prefer, libExports }) {
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
    if (!entries.has(id)) {
      let local = `__lsd_${key}_${name}`;
      while (taken.has(local)) local = `_${local}`;
      taken.add(local);
      entries.set(id, { specifier, name, named: adapter.named, local });
    }
    return { ref: entries.get(id).local, adapter };
  };

  const resolve = (step) => {
    const fail = (message) => {
      throw new LsdSyntaxError(message, step.source, step.start);
    };
    const resolved = resolveAdapter(adapters, step.lib);
    if (!resolved) {
      fail(`unknown library '${step.lib}'${didYouMean(step.lib, Object.keys(adapters))}, configure it via the 'libs' option`);
    }
    const { key, adapter } = resolved;
    if (!adapter.module) fail(`library '${key}' has no module configured`);
    const known = libExports[key];
    if (known && !known.has(step.name)) fail(`'${step.name}' is not exported by '${key}'${didYouMean(step.name, known)}`);
    return entryFor(key, adapter, step.name);
  };

  const implicit = (step) => {
    const hit = preferred.find(({ known }) => known.has(step.name));
    return hit ? entryFor(hit.key, hit.adapter, step.name) : null;
  };

  // one declaration per module: `import { a as __lsd_x_a, b as __lsd_x_b } from 'x';`
  const code = () => {
    const named = new Map();
    const defaults = [];
    for (const { specifier, name, named: isNamed, local } of entries.values()) {
      if (isNamed) named.set(specifier, [...(named.get(specifier) ?? []), `${name} as ${local}`]);
      else defaults.push(`import ${local} from ${quote(specifier)};`);
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
