// runtime fallback. in a build with the compiler every `lsd.fn('...')` with a static spec
// is replaced by the generated function, so this code only runs in dev / unbuilt setups
// or for dynamic specs. both paths share parse + generate, so the semantics are identical.

import { parse } from './parse.js';
import { generate } from './generate.js';
import { builtins, createVocabulary, normalizeOp } from './ops.js';

const vocabulary = createVocabulary(builtins);
const cache = new Map();

function code(spec) {
  return generate(parse(spec), { vocabulary, spec });
}

function fn(spec) {
  let compiled = cache.get(spec);
  if (!compiled) {
    compiled = new Function(`return ${code(spec)}`)();
    cache.set(spec, compiled);
  }
  return compiled;
}

// define(name, op) or define({ name: op, ... }).
// NOTE: the compiler does not see runtime definitions, pass the same ops via its `ops` option.
function define(name, value) {
  const entries = typeof name === 'string' ? [[name, value]] : Object.entries(name);
  for (const [key, op] of entries) vocabulary[key] = normalizeOp(key, op);
  cache.clear();
}

export const lsd = { fn, code, define };

export { parse, LsdSyntaxError } from './parse.js';
export { generate } from './generate.js';
export { builtins, createVocabulary } from './ops.js';
