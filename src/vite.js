// vite / rollup plugin. runs after vite's own ts / jsx transform, so it only ever sees plain javascript.
// with plain rollup put it after the typescript plugin.

import { compile } from './compiler/index.js';
import { loadLibExports } from './compiler/exports.js';

const LIB_PREFIX = /([A-Za-z_$][\w$]*)::/g;

export default function lsd(options = {}) {
  const {
    include = /\.[cm]?[jt]sx?$/,
    exclude = /[\\/]node_modules[\\/]/,
    module = 'wtf.js',
    prefer = [],
    ...compileOptions
  } = options;

  let root = process.cwd();
  // adapter key -> Promise<Set | null>, shared across files
  const exportsCache = new Map();

  return {
    name: 'wtf-lsd',

    configResolved(config) {
      root = config.root;
    },

    async transform(code, id) {
      const file = id.split('?')[0];
      if (!include.test(file) || exclude.test(file) || !code.includes(module)) return null;

      // exports of preferred and explicitly used libraries, for implicit lookup and typo checks
      const wanted = new Set(prefer);
      for (const [, name] of code.matchAll(LIB_PREFIX)) wanted.add(name);
      const libExports = await loadLibExports([...wanted], { libs: compileOptions.libs, root, cache: exportsCache });

      try {
        return compile(code, {
          ...compileOptions,
          module,
          prefer,
          libExports,
          filename: file,
          onWarn: (message) => this.warn(message),
        });
      } catch (error) {
        this.error(error);
      }
    },
  };
}
