export type Arity = 'none' | 'optional' | 'required';

export interface LsdEmitContext {
  /** sub-pipeline as arrow function source, or null */
  body: string | null;
  /** hoists code into a temp const of the current function, returns its identifier */
  bind(code: string): string;
}

export interface LsdOp {
  /** turns the input expression (source) into the output expression (source) */
  emit(input: string, args: string | null, context: LsdEmitContext): string;
  /** true if `input` is used more than once, forces a temp binding */
  ref?: boolean;
  args?: Arity;
  body?: Arity;
}

/** a spec string is a macro, e.g. `'lodash::kebabCase'` or `'trim lower'` */
export type LsdOpLike = string | LsdOp | ((input: string, args: string | null, context: LsdEmitContext) => string);

export interface LsdAdapter {
  /** import specifier, or a function for per-function modules (`lodash/kebabCase`) */
  module?: string | ((name: string) => string);
  /** named import (default) or default import of `module(name)` */
  named?: boolean;
  /** argument order of the library functions */
  order?: 'data-first' | 'data-last';
}

/** a string is an alias for another adapter */
export type LsdAdapterLike = LsdAdapter | string;

export interface Lsd {
  /** builds a helper function from a spec, e.g. `lsd.fn('trim lower')` */
  fn<I = any, O = any>(spec: string): (value: I, ...rest: any[]) => O;
  /** tagged template, interpolations are captured: lsd.fn`or(${fallback}) trim` */
  fn<I = any, O = any>(strings: TemplateStringsArray, ...values: unknown[]): (value: I, ...rest: any[]) => O;
  /** returns the generated source for a spec */
  code(spec: string): string;
  /** extends the runtime vocabulary. the compiler needs the same ops via its `ops` option */
  define(name: string, op: LsdOpLike): void;
  define(ops: Record<string, LsdOpLike>): void;
  /** registers a library object for `name::fn` steps at runtime */
  use(name: string, lib: object, adapter?: LsdAdapter): void;
  /** names outside the vocabulary resolve to these libraries first, no arguments switches it off */
  prefer(...names: string[]): void;
}

export declare const lsd: Lsd;
