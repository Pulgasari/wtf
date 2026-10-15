export type Arity = 'none' | 'optional' | 'required';

export interface LsdEmitContext {
  /** body as arrow function source (grammar per `bodyKind`), or null */
  body: string | null;
  /** hoists code into a temp const of the current function, returns its identifier */
  bind(code: string): string;
  /** like bind, for pure functions: the same code is hoisted only once per function */
  helper(code: string): string;
  /** calls a generated arrow on `input`, inlined where possible */
  apply(fnCode: string, input: string): string;
}

export interface LsdOp {
  /** turns the input expression (source) into the output expression (source) */
  emit(input: string, args: string | null, context: LsdEmitContext): string;
  /** true if `input` is used more than once, forces a temp binding */
  ref?: boolean;
  args?: Arity;
  body?: Arity;
  /** grammar of the `[...]` body, `?[...]` is always 'is' */
  bodyKind?: 'fn' | 'is' | 'cmp' | 'match' | 'fmt';
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

/** a factory takes a spec string or works as tagged template (interpolations are captured) */
export interface LsdFactory<F> {
  (spec: string): F;
  (strings: TemplateStringsArray, ...values: unknown[]): F;
}

export interface LsdGuessOptions {
  /** extra candidate steps, e.g. `["split(',')", 'map[trim]']` */
  hints?: string[];
  /** search budget, simple steps cost 1, heavy ones up to 3 (default 6) */
  maxCost?: number;
}

/** callable chain: `lsd.$.trim.lower(' A ')` */
export type LsdChain = ((value: any, ...rest: any[]) => any) & { readonly [step: string]: LsdChain };

export interface Lsd {
  /** pipeline: `lsd.fn('trim lower')` */
  fn: LsdFactory<(value: any, ...rest: any[]) => any>;
  /** predicate: `lsd.is('string filled or nil')` */
  is: LsdFactory<(value: any) => boolean> & {
    /** custom checks for lsd.is, macros use the is grammar */
    define(name: string, op: LsdOpLike): void;
    define(ops: Record<string, LsdOpLike>): void;
  };
  /** comparator: `lsd.cmp('.age desc, .name natural')` */
  cmp: LsdFactory<(a: any, b: any) => number>;
  /** pattern matching: `lsd.match('number -> (it * 2) | _ -> str')` */
  match: LsdFactory<(value: any) => any>;
  /** string template: `lsd.fmt('{.first} {.last upper}')` */
  fmt: LsdFactory<(value: any) => string>;
  /** property chain of argument-free steps: `lsd.$.trim.lower` */
  $: LsdChain;
  /** programming by example: `lsd.guess({ ' A ': 'a' })` */
  guess: ((examples: Record<string, unknown> | Array<[unknown, unknown]>, options?: LsdGuessOptions) => (value: any) => any) & {
    /** the found spec instead of the function */
    spec(examples: Record<string, unknown> | Array<[unknown, unknown]>, options?: LsdGuessOptions): string;
  };
  /** returns the generated source for a spec */
  code(spec: string, kind?: 'fn' | 'is' | 'cmp' | 'match' | 'fmt'): string;
  /** extends the runtime vocabulary. the compiler needs the same ops via its `ops` option */
  define(name: string, op: LsdOpLike): void;
  define(ops: Record<string, LsdOpLike>): void;
  /** registers a library object for `name::fn` steps at runtime */
  use(name: string, lib: object, adapter?: LsdAdapter): void;
  /** names outside the vocabulary resolve to these libraries first, no arguments switches it off */
  prefer(...names: string[]): void;
}

export declare const lsd: Lsd;
