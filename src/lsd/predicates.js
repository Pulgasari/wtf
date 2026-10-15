// builtin checks for lsd.is / lsd.check (and `?[...]` callbacks, `is[...]`, match conditions).
// same op shape as fn ops (vocabulary.js), but emit returns a boolean expression. `x` may be used repeatedly,
// the generator only ever passes identifiers or side-effect free property paths.
// a spec string is a macro in predicate grammar: `filled: 'not empty'`.

import { defineOp } from './vocabulary.js';

const op = (emit, options = {}) => defineOp(emit, { bodyKind: 'is', ...options });
const withArgs = (emit) => op(emit, { args: 'required' });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY =
  '(v) => v == null || (typeof v === \'string\' || Array.isArray(v) ? v.length === 0 : ' +
  'v instanceof Map || v instanceof Set ? v.size === 0 : typeof v === \'object\' ? Object.keys(v).length === 0 : false)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const predicates = {
  // types
  string: op((x) => `typeof ${x} === 'string'`),
  number: op((x) => `typeof ${x} === 'number' && !Number.isNaN(${x})`),
  integer: op((x) => `Number.isInteger(${x})`),
  boolean: op((x) => `typeof ${x} === 'boolean'`),
  bigint: op((x) => `typeof ${x} === 'bigint'`),
  function: op((x) => `typeof ${x} === 'function'`),
  object: op((x) => `${x} !== null && typeof ${x} === 'object' && !Array.isArray(${x})`),
  // array[checks] checks every item
  array: op((x, _args, { body }) => (body ? `Array.isArray(${x}) && ${x}.every(${body})` : `Array.isArray(${x})`), {
    body: 'optional',
  }),
  date: op((x) => `${x} instanceof Date && !Number.isNaN(${x}.getTime())`),
  regex: op((x) => `${x} instanceof RegExp`),
  instance: withArgs((x, args) => `${x} instanceof ${args}`),

  // presence
  nil: op((x) => `${x} == null`),
  defined: op((x) => `${x} !== undefined`),
  present: op((x) => `${x} != null`),
  truthy: op((x) => `Boolean(${x})`),
  falsy: op((x) => `!${x}`),
  // null, '', [], {}, empty Map / Set
  empty: op((x, _args, { helper }) => `${helper(EMPTY)}(${x})`),
  filled: 'not empty',
  blank: op((x) => `${x} == null || (typeof ${x} === 'string' && ${x}.trim() === '')`),

  // comparison
  eq: withArgs((x, args) => `${x} === (${args})`),
  ne: withArgs((x, args) => `${x} !== (${args})`),
  gt: withArgs((x, args) => `${x} > (${args})`),
  gte: withArgs((x, args) => `${x} >= (${args})`),
  lt: withArgs((x, args) => `${x} < (${args})`),
  lte: withArgs((x, args) => `${x} <= (${args})`),
  between: withArgs((x, args) => `((min, max) => ${x} >= min && ${x} <= max)(${args})`),
  oneOf: withArgs((x, args) => `[${args}].includes(${x})`),
  positive: op((x) => `${x} > 0`),
  negative: op((x) => `${x} < 0`),
  even: op((x) => `${x} % 2 === 0`),
  odd: op((x) => `Math.abs(${x} % 2) === 1`),

  // strings and lists
  match: withArgs((x, args) => `typeof ${x} === 'string' && (${args}).test(${x})`),
  startsWith: withArgs((x, args) => `typeof ${x} === 'string' && ${x}.startsWith(${args})`),
  endsWith: withArgs((x, args) => `typeof ${x} === 'string' && ${x}.endsWith(${args})`),
  includes: withArgs((x, args) => `Boolean(${x}?.includes?.(${args}))`),
  len: withArgs((x, args) => `${x}?.length === (${args})`),
  minLen: withArgs((x, args) => `${x}?.length >= (${args})`),
  maxLen: withArgs((x, args) => `${x}?.length <= (${args})`),
  email: op((x) => `typeof ${x} === 'string' && ${EMAIL}.test(${x})`),
  url: op((x) => `typeof ${x} === 'string' && URL.canParse(${x})`),
  uuid: op((x) => `typeof ${x} === 'string' && ${UUID}.test(${x})`),
  numeric: op((x) => `typeof ${x} === 'string' && ${x}.trim() !== '' && !Number.isNaN(Number(${x}))`),
};
