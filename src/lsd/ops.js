// the vocabulary. an entry is either a code generator or a macro.
//
// code generator: turns an input expression (source string) into an output expression.
//   emit(x, args, { body, bind })
//                  x     input expression
//                  args  raw args source or null
//                  body  source of the sub-pipeline as arrow function, or null
//                  bind  bind(code) -> identifier, hoists code into a temp const of the current function
//                  the result must be safe to chain `.member` onto, so operator-based output wraps itself in parens.
//   ref            true if `x` is used more than once. the generator then binds the current value first,
//                  so `x` is always a plain identifier.
//   args, body     'none' | 'optional' | 'required'
//
// macro: a spec string, expanded in place. `kebab: 'lodash::kebabCase'`, `clean: 'trim lower'`.
//   a single-step macro forwards args and body of the call site: `chunk(2)` -> `lodash::chunk(2)`.

import { parse } from './parse.js';

const op = (emit, options = {}) => ({ emit, ref: false, args: 'none', body: 'none', ...options });

// three-way compare used by sortBy
const CMP = '(a < b ? -1 : a > b ? 1 : 0)';

export const builtins = {
  // strings
  lower: op((x) => `${x}.toLowerCase()`),
  upper: op((x) => `${x}.toUpperCase()`),
  capitalize: op((x) => `(${x}.charAt(0).toUpperCase() + ${x}.slice(1))`, { ref: true }),
  words: op((x) => `${x}.split(/\\s+/).filter(Boolean)`),
  slug: op(
    (x) =>
      `${x}.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\u00df/g, 'ss')` +
      `.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')`,
  ),

  // coercion
  str: op((x) => `String(${x})`),
  num: op((x) => `Number(${x})`),
  int: op((x) => `Number.parseInt(${x}, 10)`),
  float: op((x) => `Number.parseFloat(${x})`),
  bool: op((x) => `Boolean(${x})`),
  not: op((x) => `(!${x})`),

  // arrays (non-mutating)
  compact: op((x) => `${x}.filter(Boolean)`),
  unique: op((x) => `[...new Set(${x})]`),
  first: op((x) => `${x}[0]`),
  last: op((x) => `${x}.at(-1)`),
  sum: op((x) => `${x}.reduce((a, b) => a + b, 0)`),
  // arrays and strings, unicode aware
  reverse: op((x) => `(typeof ${x} === 'string' ? [...${x}].reverse().join('') : ${x}.toReversed())`, { ref: true }),
  sortBy: op(
    (x, _args, { body, bind }) => {
      if (!body) return `${x}.toSorted((a, b) => ${CMP})`;
      const key = bind(body);
      return `${x}.toSorted((a, b) => { a = ${key}(a); b = ${key}(b); return ${CMP}; })`;
    },
    { body: 'optional' },
  ),
  groupBy: op((x, _args, { body }) => `Object.groupBy(${x}, ${body})`, { body: 'required' }),

  // objects
  keys: op((x) => `Object.keys(${x})`),
  values: op((x) => `Object.values(${x})`),
  entries: op((x) => `Object.entries(${x})`),
  json: op((x) => `JSON.stringify(${x})`),
  parseJson: op((x) => `JSON.parse(${x})`),

  // misc
  or: op((x, args) => `(${x} ?? ${args})`, { args: 'required' }),
  log: op((x) => `(console.log(${x}), ${x})`, { ref: true }),
};

// accepts a spec string (macro), the full op shape or a bare emit function
export function normalizeOp(name, value) {
  if (typeof value === 'string') return { macro: parse(value), source: value };
  if (typeof value === 'function') return op(value, { args: 'optional', body: 'optional' });
  if (value && typeof value.emit === 'function') return op(value.emit, value);
  throw new TypeError(`lsd: op '${name}' must be a spec string, a function or { emit }`);
}

export function createVocabulary(...sources) {
  const vocabulary = Object.create(null);
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      vocabulary[name] = normalizeOp(name, value);
    }
  }
  return vocabulary;
}
