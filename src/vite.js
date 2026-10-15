// vite / rollup plugin. runs after vite's own ts / jsx transform, so it only ever sees plain javascript.
// with plain rollup put it after the typescript plugin.

import { compile } from './compiler/index.js';

export default function lsd(options = {}) {
  const { include = /\.[cm]?[jt]sx?$/, exclude = /[\\/]node_modules[\\/]/, ...compileOptions } = options;

  return {
    name: 'wtf-lsd',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!include.test(file) || exclude.test(file)) return null;

      try {
        return compile(code, { ...compileOptions, filename: file, onWarn: (message) => this.warn(message) });
      } catch (error) {
        this.error(error);
      }
    },
  };
}
