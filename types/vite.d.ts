import type { CompileOptions } from './compiler.js';

export interface LsdPluginOptions extends Omit<CompileOptions, 'filename' | 'onWarn'> {
  include?: RegExp;
  exclude?: RegExp;
}

export default function lsd(options?: LsdPluginOptions): {
  name: string;
  transform(code: string, id: string): unknown;
};
