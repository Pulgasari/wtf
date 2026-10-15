// the vocabulary: every op turns an input expression (source string) into an output expression.
//
//   emit(x, args)  returns the new expression. it must be safe to chain `.member` onto,
//                  so anything operator-based wraps itself in parens.
//   ref            true if `x` is used more than once. the generator then binds the
//                  current value to a temp const, so `x` is always a plain identifier.
//   args           'none' | 'optional' | 'required'

const op = (emit, options = {}) => ({ emit, ref: false, args: 'none', ...options });

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

  // arrays
  compact: op((x) => `${x}.filter(Boolean)`),
  unique: op((x) => `[...new Set(${x})]`),
  first: op((x) => `${x}[0]`),
  last: op((x) => `${x}.at(-1)`),
  sum: op((x) => `${x}.reduce((a, b) => a + b, 0)`),

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

// accepts the full op shape or a bare emit function
export function normalizeOp(name, value) {
  if (typeof value === 'function') return op(value, { args: 'optional' });
  if (value && typeof value.emit === 'function') return op(value.emit, value);
  throw new TypeError(`lsd: op '${name}' must be a function or { emit }`);
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
