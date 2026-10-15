// runtime fallback. in a build with the compiler every `lsd.fn('...')` with a static spec
// is replaced by the generated function, so this code only runs in dev / unbuilt setups
// or for dynamic specs. both paths share parse + generate, so the semantics are identical.

import { parse, LsdSyntaxError } from './parse.js';
import { generate } from './generate.js';
import { builtins, createVocabulary, normalizeOp } from './ops.js';
import { createAdapters, resolveAdapter } from './libs.js';

const vocabulary = createVocabulary(builtins);
const adapterConfig = {};
let adapters = createAdapters();
// adapter key -> library object, passed into generated functions as `$libs`
const libs = Object.create(null);
const cache = new Map();

// at runtime a `lib::name` step reads the function from the object registered via `use`
function resolveLib(step, ctx) {
  const resolved = resolveAdapter(adapters, step.lib);
  const fail = (message) => {
    throw new LsdSyntaxError(message, ctx.spec, step.start);
  };
  if (!resolved) fail(`unknown library '${step.lib}'`);
  const target = libs[resolved.key];
  if (!target) fail(`library '${resolved.key}' is not registered, call lsd.use('${resolved.key}', lib) first`);
  if (typeof target[step.name] !== 'function') fail(`'${step.name}' is not a function of '${resolved.key}'`);
  return { ref: `$libs.${resolved.key}.${step.name}`, adapter: resolved.adapter };
}

function code(spec) {
  return generate(parse(spec), { vocabulary, spec, lib: resolveLib });
}

function fn(spec) {
  let compiled = cache.get(spec);
  if (!compiled) {
    compiled = new Function('$libs', `return ${code(spec)}`)(libs);
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

// registers a library object for `name::fn` steps.
// use('lodash', _) for builtin adapters, use('mine', lib, { order: 'data-last' }) for custom ones.
function use(name, lib, adapter) {
  if (adapter || !resolveAdapter(adapters, name)) {
    adapterConfig[name] = adapter ?? {};
    adapters = createAdapters(adapterConfig);
  }
  const { key } = resolveAdapter(adapters, name);
  libs[key] = lib;
  cache.clear();
}

export const lsd = { fn, code, define, use };

export { parse, LsdSyntaxError } from './parse.js';
export { generate } from './generate.js';
export { builtins, createVocabulary } from './ops.js';
export { adapters, createAdapters } from './libs.js';
