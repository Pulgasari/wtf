// runtime fallback. in a build with the compiler every `lsd.fn` with a static spec is replaced by
// the generated function, so this code only runs in dev / unbuilt setups or for dynamic specs.
// both paths share parse + generate, so the semantics are identical.

import { parse, joinTemplate, LsdSyntaxError } from './parse.js';
import { generate } from './generate.js';
import { builtins, createVocabulary, normalizeOp } from './ops.js';
import { createAdapters, resolveAdapter, didYouMean } from './libs.js';

const vocabulary = createVocabulary(builtins);
const adapterConfig = {};
let adapters = createAdapters();
let preferred = [];
// adapter key -> library object, passed into generated functions as `$libs`
const libs = Object.create(null);
// spec -> function, template strings -> factory
let cache = new Map();
let templates = new WeakMap();

const isFn = (target, name) => Object.hasOwn(target, name) && typeof target[name] === 'function';
const functionNames = (target) => Object.keys(target).filter((key) => typeof target[key] === 'function');

// at runtime a `lib::name` step reads the function from the object registered via `use`
function resolveLib(step, ctx) {
  const fail = (message) => {
    throw new LsdSyntaxError(message, ctx.spec, step.start);
  };
  const resolved = resolveAdapter(adapters, step.lib);
  if (!resolved) fail(`unknown library '${step.lib}'${didYouMean(step.lib, Object.keys(adapters))}`);
  const target = libs[resolved.key];
  if (!target) fail(`library '${resolved.key}' is not registered, call lsd.use('${resolved.key}', lib) first`);
  if (!isFn(target, step.name)) {
    fail(`'${step.name}' is not a function of '${resolved.key}'${didYouMean(step.name, functionNames(target))}`);
  }
  return { ref: `$libs.${resolved.key}.${step.name}`, adapter: resolved.adapter };
}

// names outside the vocabulary are looked up in the preferred libraries, in order
function resolveImplicit(step) {
  for (const name of preferred) {
    const resolved = resolveAdapter(adapters, name);
    const target = resolved && libs[resolved.key];
    if (target && isFn(target, step.name)) {
      return { ref: `$libs.${resolved.key}.${step.name}`, adapter: resolved.adapter };
    }
  }
  return null;
}

function source(spec, captures = 0) {
  return generate(parse(spec), { vocabulary, spec, captures, lib: resolveLib, implicit: resolveImplicit });
}

function fn(spec, ...values) {
  if (Array.isArray(spec) && Array.isArray(spec.raw)) {
    let factory = templates.get(spec);
    if (!factory) {
      const joined = joinTemplate(spec.raw);
      const names = values.map((_, index) => `$${index}`);
      factory = new Function('$libs', ...names, `return ${source(joined, values.length)}`);
      templates.set(spec, factory);
    }
    return factory(libs, ...values);
  }

  let compiled = cache.get(spec);
  if (!compiled) {
    compiled = new Function('$libs', `return ${source(spec)}`)(libs);
    cache.set(spec, compiled);
  }
  return compiled;
}

function reset() {
  cache = new Map();
  templates = new WeakMap();
}

// define(name, op) or define({ name: op, ... }).
// NOTE: the compiler does not see runtime definitions, pass the same ops via its `ops` option.
function define(name, value) {
  const entries = typeof name === 'string' ? [[name, value]] : Object.entries(name);
  for (const [key, op] of entries) vocabulary[key] = normalizeOp(key, op);
  reset();
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
  reset();
}

// prefer('lodash', 'ramda'): names outside the vocabulary resolve to these libraries before
// falling back to a method call. call without arguments to switch it off.
function prefer(...names) {
  preferred = names;
  reset();
}

function code(spec) {
  return source(spec);
}

export const lsd = { fn, code, define, use, prefer };

export { parse, joinTemplate, LsdSyntaxError } from './parse.js';
export { generate } from './generate.js';
export { builtins, createVocabulary } from './ops.js';
export { adapters, createAdapters } from './libs.js';
