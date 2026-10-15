import type { LsdOpLike } from './index.js';

export interface CompileOptions {
  filename?: string;
  /** additional ops, merged over the builtins */
  ops?: Record<string, LsdOpLike>;
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
