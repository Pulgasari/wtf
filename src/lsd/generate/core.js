// shared machinery of every grammar: scopes, the fn pipeline (chain), builders, macros and helpers.
// grammars reach each other through `ctx.compile(kind, range)`, so there are no import cycles.

import { LsdSyntaxError, parseObjectEntries, parseTupleItems } from '../parse.js';
import { libCall } from '../libs.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const CAPTURE = /^\$\d+$/;
const MAX_MACRO_DEPTH = 32;

// --- scopes -------------------------------------------------------------------------------------

// one generated function: temp consts go into `lines`, `param` holds the pipeline value.
// bind(code) hoists any expression, helper(code) hoists a pure function once per scope,
// apply(fnCode, x) calls a generated arrow on x, inlined when it is a single expression over `it`.
export function functionScope(param = 'it', reassign = true) {
  const lines = [];
  const helpers = new Map();
  let temp = 0;

  const bind = (code) => {
    const id = `_${temp++}`;
    lines.push(`const ${id} = ${code};`);
    return id;
  };
  const helper = (code) => {
    if (!helpers.has(code)) helpers.set(code, bind(code));
    return helpers.get(code);
  };
  const apply = (fnCode, x) => {
    const head = /^\(it\) => (?!\{)/.exec(fnCode);
    return head && x === 'it' ? fnCode.slice(head[0].length) : `${bind(fnCode)}(${x})`;
  };

  return { lines, bind, helper, apply, param, reassign, safe: false, trace: null };
}

// a scope for grammars that never reassign their param (is, cmp, match, fmt, parse, check)
export const fixedScope = () => functionScope('it', false);

// sub-pipelines evaluated in place (object values, tuple items, fmt interpolations).
// they share the temps of the enclosing function but must not reassign its param.
export function inlineScope(scope, safe = scope.safe) {
  return { ...scope, reassign: false, param: scope.param === 'it' ? 'it' : null, safe, trace: null };
}

export function render({ params = ['it'], lines, expr }) {
  const head = `(${params.join(', ')})`;
  return lines.length ? `${head} => { ${lines.join(' ')} return ${expr}; }` : `${head} => ${expr}`;
}

// --- fn -----------------------------------------------------------------------------------------

export function compileFn(steps, ctx, trace = null) {
  let params = ['it'];
  let rest = steps;
  if (steps[0]?.type === 'params') {
    params = steps[0].names;
    rest = steps.slice(1);
  }
  const param = params.includes('it') ? 'it' : params[0];
  const scope = { ...functionScope(param), trace };
  const expr = chain(rest, param, scope, ctx);
  return { params, lines: scope.lines, expr };
}

// a pipeline applied lazily (match branches, cmp keys): inlined if trivial, otherwise a helper
export function lazy(steps, subject, scope, ctx) {
  const fn = compileFn(steps, ctx);
  const trivial = subject === 'it' && !fn.lines.length && fn.params.length === 1 && fn.params[0] === 'it';
  return trivial ? fn.expr : `${scope.bind(render(fn))}(${subject})`;
}

export function chain(steps, start, scope, ctx) {
  const state = { safe: scope.safe };
  let expr = start;
  for (const step of expand(steps, ctx.vocabulary)) {
    expr = applyStep(step, expr, state, scope, ctx);
    scope.trace?.(step, expr);
  }
  return expr;
}

function applyStep(step, expr, state, scope, ctx) {
  const dot = state.safe ? '?.' : '.';

  switch (step.type) {
    case 'safe':
      state.safe = true;
      return expr;
    case 'params':
      return fail('a param list is only allowed at the start of a pipeline', step);
    case 'prop':
      return expr + path(step.path, dot);
    case 'expr':
      return expression(step, expr, scope);
    case 'object':
      return buildObject(step, expr, scope, ctx, state.safe);
    case 'tuple':
      return buildTuple(step, expr, scope, ctx, state.safe);
    case 'lib':
      return libStep(ctx.lib(step, ctx), step, expr, ctx);
    case 'method':
      return `${expr}${path(step.path, dot)}${dot}${step.name}(${list(body(step, null, ctx), step.args)})`;
  }

  const op = ctx.vocabulary[step.name];
  if (op) {
    checkArity(step, op);
    return op.emit(op.ref ? materialize(expr, scope) : expr, step.args, emitContext(step, op, scope, ctx));
  }
  if (CAPTURE.test(step.name)) return `${capture(step, ctx)}(${expr})`;

  // preferred library function, otherwise plain method call
  const hit = ctx.implicit(step, ctx);
  return hit ? libStep(hit, step, expr, ctx) : `${expr}${dot}${step.name}(${list(body(step, null, ctx), step.args)})`;
}

export const libStep = ({ ref, adapter }, step, subject, ctx) =>
  libCall(ref, adapter, subject, body(step, null, ctx), step.args);

// `(code)` sees the current value as `it`
function expression(step, expr, scope) {
  if (expr === scope.param) return `(${step.code})`;
  if (scope.reassign) {
    scope.lines.push(`${scope.param} = ${expr};`);
    return `(${step.code})`;
  }
  return `((it) => (${step.code}))(${expr})`;
}

function buildObject(step, expr, scope, ctx, safe) {
  const subject = materialize(expr, scope);
  const inner = inlineScope(scope, safe);
  const parts = parseObjectEntries(step).map((entry) => {
    const at = { source: step.source, start: entry.start };
    if (entry.spread) return `...${entry.steps.length ? chain(entry.steps, subject, inner, ctx) : subject}`;
    if (entry.optional) fail('optional keys are only meaningful in lsd.is', at);
    if (entry.steps) return `${entry.key}: ${chain(entry.steps, subject, inner, ctx)}`;
    if (!entry.ident) fail('a quoted key needs a value', at);
    return `${entry.key}: ${subject}${safe ? '?.' : '.'}${entry.key}`;
  });
  return `({ ${parts.join(', ')} })`;
}

function buildTuple(step, expr, scope, ctx, safe) {
  const subject = materialize(expr, scope);
  const inner = inlineScope(scope, safe);
  return `[${parseTupleItems(step).items.map((steps) => chain(steps, subject, inner, ctx)).join(', ')}]`;
}

// --- shared -------------------------------------------------------------------------------------

export function emitContext(step, op, scope, ctx) {
  return { body: body(step, op, ctx), bind: scope.bind, helper: scope.helper, apply: scope.apply };
}

// the `[...]` body of a step as arrow function, in the grammar the op asks for
export function body(step, op, ctx) {
  if (!step.body) return null;
  return ctx.compile(step.body.predicate ? 'is' : (op?.bodyKind ?? 'fn'), step.body);
}

// replaces macro calls by their steps, recursively
export function expand(steps, vocabulary, stack = []) {
  const out = [];
  for (const step of steps) {
    const op = step.type === 'call' ? vocabulary[step.name] : undefined;
    if (!op?.macro) {
      out.push(step);
      continue;
    }

    if (stack.includes(step.name) || stack.length > MAX_MACRO_DEPTH) {
      fail(`recursive macro '${[...stack, step.name].join(' -> ')}'`, step);
    }
    if (op.macro[0]?.type === 'params') fail(`macro '${step.name}' declares params and cannot be used as a step`, step);

    let macro = op.macro;
    if (step.args !== null || step.body !== null) {
      // forward args / body into a single-step macro
      const [only] = macro;
      if (macro.length !== 1 || !['call', 'method', 'lib'].includes(only.type)) {
        fail(`macro '${step.name}' (${op.source}) takes no arguments`, step);
      }
      if (only.body && step.body) fail(`macro '${step.name}' already has a sub-pipeline`, step);
      macro = [{ ...only, args: mergeArgs(only.args, step.args), body: only.body ?? step.body }];
    }

    out.push(...expand(macro, vocabulary, [...stack, step.name]));
  }
  return out;
}

export const isCapture = (name) => CAPTURE.test(name);

export function capture(step, ctx) {
  if (Number(step.name.slice(1)) >= ctx.captures) fail(`unknown capture '${step.name}'`, step);
  if (step.args !== null || step.body !== null) fail('a captured function takes no arguments', step);
  return step.name;
}

export function checkArity(step, op) {
  for (const key of ['args', 'body']) {
    const given = key === 'args' ? step.args !== null && step.args !== '' : step.body !== null;
    const label = key === 'args' ? 'arguments' : 'a sub-pipeline';
    if (op[key] === 'required' && !given) fail(`op '${step.name}' requires ${label}`, step);
    if (op[key] === 'none' && given) fail(`op '${step.name}' takes no ${label}`, step);
  }
}

// expressions used more than once must be identifiers
export const materialize = (expr, scope) => (IDENT.test(expr) ? expr : scope.bind(expr));

export const keyword = (step, name) =>
  step.type === 'call' && step.name === name && step.args === null && step.body === null;

// `.path[checks]`: a method step with a plain body and no args scopes checks to a path
export const isScopedPath = (step) => step.type === 'method' && step.body && !step.body.predicate && step.args === null;

// `subject.key` / `subject['quoted key']` for object entries
export const entryAccess = (subject, entry) =>
  entry.ident ? `${subject}?.${entry.key}` : `${subject}?.[${entry.key}]`;

export const text = (step) => step.source.slice(step.start, step.end);
export const path = (keys, dot) => keys.map((key) => `${dot}${key}`).join('');
export const list = (...items) => items.filter(Boolean).join(', ');
export const wrap = (code) => (code.startsWith('(') || code === 'true' ? code : `(${code})`);

const mergeArgs = (own, forwarded) => (own && forwarded ? `${own}, ${forwarded}` : (own ?? forwarded));

export function withoutParams(steps, factory) {
  if (steps[0]?.type === 'params') fail(`${factory} takes no param list`, steps[0]);
  return steps;
}

export function fail(message, at) {
  throw new LsdSyntaxError(message, at?.source ?? '', at?.start ?? 0);
}
