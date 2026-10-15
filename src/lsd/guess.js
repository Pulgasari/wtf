// programming by example: finds the cheapest pipeline of argument-free steps that maps every
// example input to its output. `hints` adds own candidate steps (cost 1), e.g. `split(',')`.
//
//   lsd.guess({ '  Foo ': 'foo', 'BAR': 'bar' })      -> 'trim lower'
//   lsd.guess([[[3, 1, 3], [1, 3]]])                  -> 'unique sortBy'
//
// uniform-cost search: every candidate has a cost, simple steps are cheap, heavy ones (slug, json)
// expensive, so `trim lower` beats `slug` when both fit. intermediate results are computed per
// example and identical intermediate states are only expanded once.

// [spec, cost], order breaks ties
export const CANDIDATES = [
  ['trim', 1], ['lower', 1], ['upper', 1], ['.length', 1], ['first', 1], ['last', 1],
  ['unique', 1], ['sortBy', 1], ['compact', 1], ['str', 1], ['num', 1], ['int', 1],
  ['capitalize', 2], ['words', 2], ['reverse', 2], ['sum', 2], ['keys', 2], ['values', 2],
  ['float', 2], ['bool', 2], ['not', 2], ['trimStart', 2], ['trimEnd', 2], ['flat', 2],
  ['entries', 3], ['slug', 3], ['json', 3], ['parseJson', 3],
];

const MISSING = Symbol('missing');

/**
 * @param {object | Array<[unknown, unknown]>} examples  { input: output } or [[input, output], ...]
 * @param {(spec: string) => Function} compileStep        builds a single step
 * @returns {string | null}  the cheapest matching spec, null if there is none within `maxCost`
 */
export function guess(examples, compileStep, { maxCost = 6, candidates = CANDIDATES, hints = [] } = {}) {
  const pairs = Array.isArray(examples) ? examples : Object.entries(examples);
  if (!pairs.length) throw new TypeError('lsd.guess: needs at least one example');
  const inputs = pairs.map(([input]) => input);
  const outputs = pairs.map(([, output]) => output);
  const matches = (values) => values.every((value, index) => same(value, outputs[index]));

  const steps = [...hints.map((spec) => [spec, 1]), ...candidates].map(([spec, cost]) => ({ spec, cost, fn: compileStep(spec) }));
  const buckets = [[{ specs: [], values: inputs, id: key(inputs) }]];
  // intermediate results already expanded, identical states are interchangeable
  const seen = new Set();

  for (let cost = 0; cost <= maxCost; cost++) {
    for (const state of buckets[cost] ?? []) {
      // the goal test happens on expansion, so the first hit is the cheapest
      if (matches(state.values)) return state.specs.join(' ');
      if (state.id !== null) {
        if (seen.has(state.id)) continue;
        seen.add(state.id);
      }
      for (const step of steps) {
        const next = cost + step.cost;
        if (next > maxCost) continue;
        const values = state.values.map((value) => run(step.fn, value));
        if (values.includes(MISSING)) continue;
        const id = key(values);
        if (id !== null && seen.has(id)) continue;
        (buckets[next] ??= []).push({ specs: [...state.specs, step.spec], values, id });
      }
    }
  }

  return null;
}

function run(fn, value) {
  try {
    const result = fn(value);
    return result === undefined || Number.isNaN(result) ? MISSING : result;
  } catch {
    return MISSING;
  }
}

function key(values) {
  try {
    return JSON.stringify(values);
  } catch {
    return null;
  }
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((k) => same(a[k], b[k]));
}
