// vocabulary entries: code generators or macros. shared by fn ops (ops.js) and checks (predicates.js).
//
// code generator: turns an input expression (source string) into an output expression.
//   emit(x, args, { body, bind, helper, apply })
//                  x       input expression
//                  args    raw args source or null
//                  body    the `[...]` body compiled as arrow function (grammar per bodyKind), or null
//                  bind    bind(code) -> identifier, hoists code into a temp const of the current function
//                  helper  like bind, for pure functions: the same code is hoisted only once
//                  apply   apply(fnCode, x) -> calls a generated arrow on x, inlined where possible
//                  fn ops must return expressions safe to chain `.member` onto (wrap operators in parens).
//   ref            true if `x` is used more than once. the generator then binds the current value first,
//                  so `x` is always a plain identifier.
//   args, body     'none' | 'optional' | 'required'
//   bodyKind       grammar of the `[...]` body: 'fn', 'is', 'cmp', 'match', 'fmt'. `?[...]` is always 'is'.
//
// macro: a spec string, expanded in place. `kebab: 'lodash::kebabCase'`, `filled: 'not empty'`.
//   a single-step macro forwards args and body of the call site: `chunk(2)` -> `lodash::chunk(2)`.

import { parse } from './parse.js';

export const defineOp = (emit, options = {}) => ({
  emit,
  ref: false,
  args: 'none',
  body: 'none',
  bodyKind: 'fn',
  ...options,
});

// accepts a spec string (macro), the full op shape or a bare emit function.
// `bodyKind` is the default body grammar: 'fn' for ops, 'is' for checks.
export function normalizeOp(name, value, bodyKind = 'fn') {
  if (typeof value === 'string') return { macro: parse(value), source: value };
  if (typeof value === 'function') return defineOp(value, { args: 'optional', body: 'optional', bodyKind });
  if (typeof value?.emit === 'function') return defineOp(value.emit, { bodyKind, ...value });
  throw new TypeError(`lsd: op '${name}' must be a spec string, a function or { emit }`);
}

export function createVocabularyOf(bodyKind, sources) {
  const vocabulary = Object.create(null);
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) vocabulary[name] = normalizeOp(name, value, bodyKind);
  }
  return vocabulary;
}
