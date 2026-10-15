// builtin fn ops: native one-liners. op shape and macros are described in vocabulary.js.

import { defineOp as op, createVocabularyOf } from './vocabulary.js';
import { predicates } from './predicates.js';

// three-way compare used by sortBy (and lsd.cmp)
export const CMP = '(x, y) => (x < y ? -1 : x > y ? 1 : 0)';

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
  // keys are computed once per item (decorate, sort, undecorate), not once per comparison
  sortBy: op(
    (x, _args, { body, bind, helper }) => {
      if (!body) return `${x}.toSorted(${helper(CMP)})`;
      const key = bind(body);
      return `${x}.map((v) => [${key}(v), v]).sort((a, b) => ${helper(CMP)}(a[0], b[0])).map((p) => p[1])`;
    },
    { body: 'optional' },
  ),
  groupBy: op((x, _args, { body }) => `Object.groupBy(${x}, ${body})`, { body: 'required' }),
  // order[.age desc, .name] -> sorted copy, body in lsd.cmp grammar
  order: op((x, _args, { body }) => `${x}.toSorted(${body ?? ''})`, { body: 'optional', bodyKind: 'cmp' }),

  // other grammars applied to the current value
  is: op((x, _args, { body, apply }) => apply(body, x), { body: 'required', bodyKind: 'is' }),
  when: op((x, _args, { body, apply }) => apply(body, x), { body: 'required', bodyKind: 'match' }),
  fmt: op((x, _args, { body, apply }) => apply(body, x), { body: 'required', bodyKind: 'fmt' }),

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

export const createVocabulary = (...sources) => createVocabularyOf('fn', [builtins, ...sources]);

// fn ops and checks with user additions merged over the builtins
export const createVocabularies = (ops, checks) => ({
  vocabulary: createVocabularyOf('fn', [builtins, ops]),
  predicates: createVocabularyOf('is', [predicates, checks]),
});
