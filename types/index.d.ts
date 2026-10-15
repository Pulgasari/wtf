export interface LsdOp {
  /** turns the input expression (source) into the output expression (source) */
  emit(input: string, args: string | null): string;
  /** true if `input` is used more than once, forces a temp binding */
  ref?: boolean;
  args?: 'none' | 'optional' | 'required';
}

export type LsdOpLike = LsdOp | ((input: string, args: string | null) => string);

export interface Lsd {
  /** builds a helper function from a spec, e.g. `lsd.fn('trim lower')` */
  fn<I = any, O = any>(spec: string): (value: I) => O;
  /** returns the generated source for a spec */
  code(spec: string): string;
  /** extends the runtime vocabulary. the compiler needs the same ops via its `ops` option */
  define(name: string, op: LsdOpLike): void;
  define(ops: Record<string, LsdOpLike>): void;
}

export declare const lsd: Lsd;
