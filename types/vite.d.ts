import type { CompileOptions } from './compiler.js';

export interface LsdPluginOptions extends Omit<CompileOptions, 'filename' | 'onWarn' | 'libExports'> {
  include?: RegExp;
  exclude?: RegExp;
}

export default function lsd(options?: LsdPluginOptions): {
  name: string;
  configResolved(config: { root: string }): void;
  transform(code: string, id: string): Promise<unknown>;
};
