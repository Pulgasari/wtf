// code generation for every factory. all of them share the step grammar (parse.js) and differ in
// how they read it:
//
//   fn     pipeline, value in -> value out              lsd.fn('trim lower')
//   is     checks, combined with `not` / `or`           lsd.is('string filled or nil')
//   cmp    comma separated sort keys + asc/desc/natural lsd.cmp('.age desc, .name natural')
//   match  `checks -> pipeline` cases separated by `|`  lsd.match('number -> (it * 2) | _ -> str')
//   fmt    text with `{pipeline}` interpolations        lsd.fmt('{.first} {.last upper}')
//   parse  the inverse of fmt, text -> object           lsd.parse('{name} ({age int})')
//   check  is grammar, returns errors with paths        lsd.check('{ name: string filled }')
//
// every factory returns the source of an arrow function. grammars nest through bodies:
// `filter?[...]` is an `is` body, `order[...]` a `cmp` body and so on.

import { parseBody, parseRange } from '../parse.js';
import { compileFn, fail, render, text } from './core.js';
import { isKind } from './is.js';
import { checkKind } from './check.js';
import { cmpKind } from './cmp.js';
import { matchKind } from './match.js';
import { fmtKind, parseKind } from './text.js';

const GRAMMARS = {
  fn: (range, ctx) => render(compileFn(parseBody(range), ctx)),
  is: isKind,
  cmp: cmpKind,
  match: matchKind,
  fmt: fmtKind,
  parse: parseKind,
  check: checkKind,
};

export const KINDS = Object.keys(GRAMMARS);

/**
 * @param {object} options
 * @param {object} options.vocabulary   fn ops
 * @param {object} [options.predicates] checks
 * @param {(step, ctx) => { ref: string, adapter: object }} [options.lib]
 *        resolves a `lib::name` step. differs between runtime (registered objects) and compiler (imports).
 * @param {(step, ctx) => { ref: string, adapter: object } | null} [options.implicit]
 *        resolves a name outside the vocabulary against preferred libraries.
 * @param {number} [options.captures]  number of `$n` captures in scope (tagged templates)
 */
export function generateKind(kind, spec, options = {}) {
  if (!GRAMMARS[kind]) throw new TypeError(`lsd: unknown factory '${kind}'`);
  return GRAMMARS[kind]({ source: spec, from: 0, to: spec.length }, context(options));
}

// fn from already parsed steps
export function generate(steps, options = {}) {
  return render(compileFn(steps, context(options)));
}

// the top-level steps of a fn spec with the expression after each one
export function explain(spec, options = {}) {
  const steps = [];
  const trace = (step, expr) => steps.push({ step: text(step), expr });
  const code = render(compileFn(parseRange(spec, 0, spec.length), context(options), trace));
  return { code, steps };
}

function context(options) {
  const ctx = {
    vocabulary: options.vocabulary ?? {},
    predicates: options.predicates ?? {},
    lib: options.lib ?? noLibs,
    implicit: options.implicit ?? (() => null),
    captures: options.captures ?? 0,
  };
  ctx.compile = (kind, range) => GRAMMARS[kind](range, ctx);
  return ctx;
}

function noLibs(step) {
  fail(`library steps are not available here (${step.lib}::${step.name})`, step);
}
