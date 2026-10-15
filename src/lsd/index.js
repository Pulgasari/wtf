// runtime fallback. in a build with the compiler every factory call with a static spec is replaced by
// the generated function, so this code only runs in dev / unbuilt setups or for dynamic specs.
// both paths share parse + generate, so the semantics are identical.

import { joinTemplate, LsdSyntaxError } from './parse.js';
import { generateKind, explain as explainSpec } from './generate.js';
import { builtins, createVocabularyOf, normalizeOp } from './ops.js';
import { predicates as builtinPredicates } from './predicates.js';
import { createAdapters, resolveAdapter, didYouMean } from './libs.js';
import { guess as search } from './guess.js';

const vocabulary = createVocabularyOf('fn', [builtins]);
const predicates = createVocabularyOf('is', [builtinPredicates]);
const adapterConfig = {};
let adapters = createAdapters();
let preferred = [];
// adapter key -> library object, passed into generated functions as `$libs`
const libs = Object.create(null);
// `${kind}:${spec}` -> function, template strings -> factory (per kind)
let cache = new Map();
let templates = new WeakMap();

const isFn = (target, name) => Object.hasOwn(target, name) && typeof target[name] === 'function';
const functionNames = (target) => Object.keys(target).filter((key) => typeof target[key] === 'function');

// at runtime a `lib::name` step reads the function from the object registered via `use`
function resolveLib(step) {
  const fail = (message) => {
    throw new LsdSyntaxError(message, step.source, step.start);
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

const options = (captures = 0) => ({ vocabulary, predicates, captures, lib: resolveLib, implicit: resolveImplicit });

function source(kind, spec, captures = 0) {
  if (typeof spec !== 'string') throw new TypeError(`lsd: spec must be a string, got ${typeof spec}`);
  return generateKind(kind, spec, options(captures));
}

// every factory works with a string spec or as tagged template (interpolations are captured)
function factory(kind) {
  return function lsdFactory(spec, ...values) {
    if (Array.isArray(spec) && Array.isArray(spec.raw)) {
      let byKind = templates.get(spec);
      if (!byKind) templates.set(spec, (byKind = {}));
      if (!byKind[kind]) {
        const names = values.map((_, index) => `$${index}`);
        byKind[kind] = new Function('$libs', ...names, `return ${source(kind, joinTemplate(spec.raw, kind), values.length)}`);
      }
      return byKind[kind](libs, ...values);
    }

    const key = `${kind}:${spec}`;
    let compiled = cache.get(key);
    if (!compiled) {
      compiled = new Function('$libs', `return ${source(kind, spec)}`)(libs);
      cache.set(key, compiled);
    }
    return compiled;
  };
}

function reset() {
  cache = new Map();
  templates = new WeakMap();
}

function defineIn(target, bodyKind, name, value) {
  const entries = typeof name === 'string' ? [[name, value]] : Object.entries(name);
  for (const [key, op] of entries) target[key] = normalizeOp(key, op, bodyKind);
  reset();
}

// define(name, op) or define({ name: op, ... }).
// NOTE: the compiler does not see runtime definitions, pass the same ops via its `ops` option.
function define(name, value) {
  defineIn(vocabulary, 'fn', name, value);
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

// lsd.$.trim.lower -> lsd.fn('trim lower'). only argument-free steps, the call runs the function.
// `then` stays undefined so the proxy is not mistaken for a thenable.
function chainProxy(steps) {
  return new Proxy(function lsdChain() {}, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return chainProxy([...steps, key]);
    },
    apply(_target, _this, args) {
      return fn(steps.join(' '))(...args);
    },
  });
}

const fn = factory('fn');
const is = Object.assign(factory('is'), {
  // custom checks, same shapes as define, macros use the is grammar
  define: (name, value) => defineIn(predicates, 'is', name, value),
});

// programming by example. the compiler runs the search at build time and inlines the result.
function guessSpec(examples, options) {
  const spec = search(examples, (step) => fn(step), options);
  if (spec === null) throw new Error('lsd.guess: no pipeline found for these examples, give me a hint');
  return spec;
}

const guess = Object.assign((examples, options) => fn(guessSpec(examples, options)), { spec: guessSpec });

export const lsd = {
  fn,
  is,
  cmp: factory('cmp'),
  match: factory('match'),
  fmt: factory('fmt'),
  parse: factory('parse'),
  check: factory('check'),
  $: chainProxy([]),
  guess,
  code: (spec, kind = 'fn') => source(kind, spec),
  // { code, steps: [{ step, expr }] }: what every top-level step of a fn spec turned into
  explain: (spec) => explainSpec(spec, options()),
  define,
  use,
  prefer,
};

export { parse, joinTemplate, LsdSyntaxError } from './parse.js';
export { generate, generateKind, KINDS } from './generate.js';
export { builtins, createVocabulary } from './ops.js';
export { predicates as builtinPredicates } from './predicates.js';
export { adapters, createAdapters } from './libs.js';
