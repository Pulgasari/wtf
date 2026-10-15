// build-time lookup of library exports, used for `prefer` (implicit library functions)
// and typo checks on `lib::name`. node only.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapters, resolveAdapter } from '../lsd/libs.js';

/**
 * @param {string[]} names  adapter names or aliases (`lodash`, `_`, `R`)
 * @param {object} [options]
 * @param {object} [options.libs]   adapter config, as for compile()
 * @param {string} [options.root]   project root to resolve modules from
 * @param {Map} [options.cache]     adapter key -> Promise<Set | null>, shared across calls
 * @returns {Promise<Record<string, Set<string>>>}  adapter key -> exported function names.
 *          libraries that are not installed or use per-function modules are left out.
 */
export async function loadLibExports(names, { libs, root = process.cwd(), cache = new Map() } = {}) {
  const adapters = createAdapters(libs);
  const require = createRequire(join(root, 'noop.js'));
  const result = {};

  await Promise.all(
    names.map(async (name) => {
      const resolved = resolveAdapter(adapters, name);
      if (!resolved || typeof resolved.adapter.module !== 'string') return;
      const { key, adapter } = resolved;
      if (!cache.has(key)) cache.set(key, importExports(adapter.module, require));
      const found = await cache.get(key);
      if (found) result[key] = found;
    }),
  );

  return result;
}

async function importExports(specifier, require) {
  let url = specifier;
  if (!/^(file|data|node):/.test(specifier)) {
    try {
      url = pathToFileURL(require.resolve(specifier)).href;
    } catch {
      // not resolvable from root (esm-only exports map etc.), let import() try on its own
    }
  }
  try {
    const mod = await import(url);
    return new Set(Object.keys(mod).filter((key) => typeof mod[key] === 'function'));
  } catch {
    return null;
  }
}
