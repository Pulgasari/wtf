// utility library adapters for `lib::name` steps.
//
//   module   import specifier, or (name) => specifier for per-function modules (`lodash/kebabCase`)
//   named    true: `import { name } from module`, false: `import name from module(name)`
//   order    'data-first': fn(value, callback, ...args)   lodash, underscore, es-toolkit, remeda
//            'data-last':  fn(callback, ...args, value)   ramda
//
// a string value is an alias for another adapter.

export const adapters = {
  lodash: { module: 'lodash-es', named: true, order: 'data-first' },
  underscore: { module: 'underscore', named: true, order: 'data-first' },
  ramda: { module: 'ramda', named: true, order: 'data-last' },
  esToolkit: { module: 'es-toolkit', named: true, order: 'data-first' },
  remeda: { module: 'remeda', named: true, order: 'data-first' },
  _: 'lodash',
  R: 'ramda',
};

const ORDERS = new Set(['data-first', 'data-last']);

// merges user config over the builtins. partial objects extend the builtin adapter of the same name.
export function createAdapters(overrides = {}) {
  const merged = { ...adapters };
  for (const [name, value] of Object.entries(overrides)) {
    merged[name] =
      typeof value === 'string' || typeof merged[name] !== 'object' ? value : { ...merged[name], ...value };
  }
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value === 'string') continue;
    if (!value || !ORDERS.has(value.order ?? 'data-first')) {
      throw new TypeError(`lsd: invalid adapter '${name}', order must be 'data-first' or 'data-last'`);
    }
    merged[name] = { named: true, order: 'data-first', ...value };
  }
  return merged;
}

// follows aliases, returns { key, adapter } or null
export function resolveAdapter(adapters, name) {
  const seen = new Set();
  let key = name;
  while (typeof adapters[key] === 'string') {
    if (seen.has(key)) throw new TypeError(`lsd: circular library alias '${name}'`);
    seen.add(key);
    key = adapters[key];
  }
  const adapter = adapters[key];
  return adapter ? { key, adapter } : null;
}

// argument list for a library call in the adapter's order
export function libCall(ref, adapter, value, callback, args) {
  const rest = [callback, args].filter(Boolean);
  const list = adapter.order === 'data-last' ? [...rest, value] : [value, ...rest];
  return `${ref}(${list.join(', ')})`;
}
