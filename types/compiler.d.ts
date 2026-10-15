import type { LsdAdapterLike, LsdOpLike } from './index.js';

export interface CompileOptions {
  filename?: string;
  /** additional ops, merged over the builtins */
  ops?: Record<string, LsdOpLike>;
  /** library adapters for `lib::name` steps, merged over the builtins (lodash, underscore, ramda, esToolkit, remeda) */
  libs?: Record<string, LsdAdapterLike>;
  /** module specifier to look for, default 'wtf.js' */
  module?: string;
  sourcemap?: boolean;
  onWarn?(message: string): void;
}

export interface CompileResult {
  code: string;
  map: object | null;
  compiled: number;
}

export declare function compile(source: string, options?: CompileOptions): CompileResult | null;

export declare class LsdCompileError extends Error {
  filename?: string;
  loc?: { line: number; column: number };
}
