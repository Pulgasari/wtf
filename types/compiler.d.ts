import type { LsdAdapterLike, LsdOpLike } from './index.js';

export interface CompileOptions {
  filename?: string;
  /** additional ops, merged over the builtins */
  ops?: Record<string, LsdOpLike>;
  /** additional checks for lsd.is, merged over the builtins */
  predicates?: Record<string, LsdOpLike>;
  /** library adapters for `lib::name` steps, merged over the builtins (lodash, underscore, ramda, esToolkit, remeda) */
  libs?: Record<string, LsdAdapterLike>;
  /** names outside the vocabulary resolve to these libraries first, needs `libExports` */
  prefer?: string[];
  /** exported function names per adapter key, enables `prefer` and typo checks */
  libExports?: Record<string, Set<string>>;
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

export declare function loadLibExports(
  names: string[],
  options?: { libs?: Record<string, LsdAdapterLike>; root?: string; cache?: Map<string, Promise<Set<string> | null>> },
): Promise<Record<string, Set<string>>>;
