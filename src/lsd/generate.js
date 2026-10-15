// code generation for every factory. all of them share the step grammar (parse.js) and differ in
// how they read it:
//
//   fn     pipeline, value in -> value out              lsd.fn('trim lower')
//   is     checks, combined with `not` / `or`           lsd.is('string filled or nil')
//   cmp    comma separated sort keys + asc/desc/natural lsd.cmp('.age desc, .name natural')
//   match  `checks -> pipeline` cases separated by `|`  lsd.match('number -> (it * 2) | _ -> str')
//   fmt    text with `{pipeline}` interpolations        lsd.fmt('{.first} {.last upper}')
//
// every factory returns the source of an arrow function. sub-grammars nest through bodies:
// `filter?[...]` is an `is` body, `order[...]` a `cmp` body and so on.

import {
  LsdSyntaxError,
  parseBody,
  parseObjectEntries,
  parseRange,
  parseTupleItems,
  splitTop,
  _scanGroup as scanGroup,
} from './parse.js';
import { libCall, didYouMean } from './libs.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const CAPTURE = /^\$\d+$/;
const MAX_MACRO_DEPTH = 32;

const CMP = '(x, y) => (x < y ? -1 : x > y ? 1 : 0)';
const NATURAL = "(x, y) => String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })";
const CMP_MODIFIERS = new Set(['asc', 'desc', 'natural']);

export const KINDS = ['fn', 'is', 'cmp', 'match', 'fmt'];

/**
 * @param {object} options
 * @param {object} options.vocabulary  fn ops, from createVocabulary
 * @param {object} [options.predicates] is ops
 * @param {(step, ctx) => { ref: string, adapter: object }} [options.lib]
 *        resolves a `lib::name` step. differs between runtime (registered objects) and compiler (imports).
 * @param {(step, ctx) => { ref: string, adapter: object } | null} [options.implicit]
 *        resolves a name outside the vocabulary against preferred libraries.
 * @param {number} [options.captures]  number of `$n` captures in scope (tagged templates)
 */
export function generateKind(kind, spec, options = {}) {
  const compile = KIND[kind];
  if (!compile) throw new TypeError(`lsd: unknown factory '${kind}'`);
  return compile({ source: spec, from: 0, to: spec.length }, context(options));
}

// fn from already parsed steps
export function generate(steps, options = {}) {
  return render(compileFn(steps, context(options)));
}

function context(options) {
  return {
    vocabulary: options.vocabulary ?? {},
    predicates: options.predicates ?? {},
    lib: options.lib ?? noLibs,
    implicit: options.implicit ?? (() => null),
    captures: options.captures ?? 0,
  };
}

const KIND = {
  fn: (range, ctx) => render(compileFn(parseBody(range), ctx)),
  is: isKind,
  cmp: cmpKind,
  match: matchKind,
  fmt: fmtKind,
};

// --- scopes -------------------------------------------------------------------------------------

// one generated function: temp consts go into `lines`, `param` is the pipeline value
// bind(code) hoists any expression, helper(code) hoists a pure function once per scope.
function functionScope(param, reassign = true) {
  const lines = [];
  const counter = { n: 0 };
  const helpers = new Map();
  const bind = (code) => {
    const id = `_${counter.n++}`;
    lines.push(`const ${id} = ${code};`);
    return id;
  };
  const helper = (code) => {
    if (!helpers.has(code)) helpers.set(code, bind(code));
    return helpers.get(code);
  };
  // calls a generated arrow on `x`, inlined when it is a single expression over `it` and `x` is `it`
  const apply = (fnCode, x) => {
    const simple = /^\(it\) => (?!\{)/.exec(fnCode);
    return simple && x === 'it' ? fnCode.slice(simple[0].length) : `${bind(fnCode)}(${x})`;
  };
  return { lines, bind, helper, apply, param, reassign, safe: false };
}

// sub-pipelines evaluated in place (object values, tuple items, fmt interpolations).
// they share the temps of the enclosing function but must not reassign its param.
function inlineScope(scope, safe = scope.safe) {
  return { ...scope, reassign: false, param: scope.param === 'it' ? 'it' : null, safe };
}

function render({ params, lines, expr }) {
  const head = `(${params.join(', ')})`;
  return lines.length ? `${head} => { ${lines.join(' ')} return ${expr}; }` : `${head} => ${expr}`;
}

// --- fn -----------------------------------------------------------------------------------------

function compileFn(steps, ctx) {
  let params = ['it'];
  let rest = steps;
  if (steps[0]?.type === 'params') {
    params = steps[0].names;
    rest = steps.slice(1);
  }
  const param = params.includes('it') ? 'it' : params[0];
  const scope = functionScope(param);
  const expr = chain(rest, param, scope, ctx);
  return { params, lines: scope.lines, expr };
}

// a pipeline applied lazily (match branches, cmp keys): inlined if trivial, otherwise a helper
function lazy(steps, subject, scope, ctx) {
  const fn = compileFn(steps, ctx);
  if (subject === 'it' && !fn.lines.length && fn.params.length === 1 && fn.params[0] === 'it') return fn.expr;
  return `${scope.bind(render(fn))}(${subject})`;
}

function chain(steps, start, scope, ctx) {
  let expr = start;
  let safe = scope.safe;
  const dot = () => (safe ? '?.' : '.');

  for (const step of expand(steps, ctx.vocabulary, ctx)) {
    switch (step.type) {
      case 'safe':
        safe = true;
        continue;
      case 'params':
        fail('a param list is only allowed at the start of a pipeline', step);
        break;
      case 'prop':
        expr += path(step.path, dot());
        continue;
      case 'expr':
        expr = expression(step, expr, scope);
        continue;
      case 'object':
        expr = buildObject(step, expr, scope, ctx, safe);
        continue;
      case 'tuple':
        expr = buildTuple(step, expr, scope, ctx, safe);
        continue;
      case 'lib': {
        const { ref, adapter } = ctx.lib(step, ctx);
        expr = libCall(ref, adapter, expr, body(step, null, ctx), step.args);
        continue;
      }
    }

    const op = step.type === 'call' ? ctx.vocabulary[step.name] : undefined;

    if (!op && step.type === 'call' && CAPTURE.test(step.name)) {
      expr = `${capture(step, ctx)}(${expr})`;
      continue;
    }

    if (!op) {
      const callback = body(step, null, ctx);
      const hit = step.type === 'call' ? ctx.implicit(step, ctx) : null;
      // preferred library function, otherwise plain method call
      expr = hit
        ? libCall(hit.ref, hit.adapter, expr, callback, step.args)
        : `${expr}${step.type === 'method' ? path(step.path, dot()) : ''}${dot()}${step.name}(${list(callback, step.args)})`;
      continue;
    }

    arity(step, op, 'args');
    arity(step, op, 'body');
    if (op.ref && !IDENT.test(expr)) expr = scope.bind(expr);
    expr = op.emit(expr, step.args, emitContext(step, op, scope, ctx));
  }

  return expr;
}

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
  const subject = IDENT.test(expr) ? expr : scope.bind(expr);
  const inner = inlineScope(scope, safe);
  const dot = safe ? '?.' : '.';
  const parts = parseObjectEntries(step).map((entry) => {
    const at = { source: step.source, start: entry.start };
    if (entry.spread) return `...${entry.steps.length ? chain(entry.steps, subject, inner, ctx) : subject}`;
    if (entry.optional) fail('optional keys are only meaningful in lsd.is', at);
    if (entry.steps) return `${entry.key}: ${chain(entry.steps, subject, inner, ctx)}`;
    if (!entry.ident) fail('a quoted key needs a value', at);
    return `${entry.key}: ${subject}${dot}${entry.key}`;
  });
  return `({ ${parts.join(', ')} })`;
}

function buildTuple(step, expr, scope, ctx, safe) {
  const subject = IDENT.test(expr) ? expr : scope.bind(expr);
  const inner = inlineScope(scope, safe);
  const { items } = parseTupleItems(step);
  return `[${items.map((steps) => chain(steps, subject, inner, ctx)).join(', ')}]`;
}

// --- is -----------------------------------------------------------------------------------------

function isKind(range, ctx) {
  const steps = parseBody(range);
  if (steps[0]?.type === 'params') fail('lsd.is takes no param list', steps[0]);
  const scope = functionScope('it', false);
  return render({ params: ['it'], lines: scope.lines, expr: checks(steps, 'it', scope, ctx) });
}

const keyword = (step, name) => step.type === 'call' && step.name === name && step.args === null && step.body === null;

// boolean expression for `subject`. terms are and-ed, `or` separates groups, `not` negates the next term.
function checks(steps, subject, scope, ctx) {
  const groups = [[]];
  let negate = null;

  for (const step of expand(steps, ctx.predicates, ctx)) {
    if (step.type === 'safe') continue;
    if (keyword(step, 'or')) {
      if (negate) fail("'not' before 'or'", negate);
      if (!groups.at(-1).length) fail("empty 'or' branch", step);
      groups.push([]);
      continue;
    }
    if (keyword(step, 'not')) {
      negate = negate ? null : step;
      continue;
    }
    const term = checkTerm(step, subject, scope, ctx);
    groups.at(-1).push(negate ? `!${term}` : term);
    negate = null;
  }

  if (negate) fail("dangling 'not'", negate);
  if (groups.length === 1 && !groups[0].length) return 'true';
  if (!groups.at(-1).length) fail("empty 'or' branch", steps.at(-1));

  const ands = groups.map((group) => (group.length === 1 ? group[0] : `(${group.join(' && ')})`));
  return ands.length === 1 ? ands[0] : `(${ands.join(' || ')})`;
}

// a single check, always returns a primary expression
function checkTerm(step, subject, scope, ctx) {
  switch (step.type) {
    case 'params':
      return fail('a param list is only allowed at the start of a pipeline', step);

    // `.active` -> truthy property
    case 'prop':
      return `Boolean(${subject}${path(step.path, '?.')})`;

    case 'expr':
      return subject === 'it' && scope.param === 'it'
        ? `Boolean(${step.code})`
        : `Boolean(((it) => (${step.code}))(${subject}))`;

    // `{ name: string, age?: number }` -> shape check
    case 'object':
      return shape(step, subject, scope, ctx);

    // `[a or b]` -> group, `[string, number]` -> tuple check
    case 'tuple': {
      const { items, single } = parseTupleItems(step);
      if (single) return items.length ? wrap(checks(items[0], subject, scope, ctx)) : 'true';
      const parts = items.map((item, index) => checks(item, `${subject}[${index}]`, scope, ctx));
      return `(${[`Array.isArray(${subject})`, `${subject}.length === ${items.length}`, ...parts].join(' && ')})`;
    }

    // `.name[checks]` scopes checks to a path, `.isValid()` / `.some?[...]` call a method
    case 'method': {
      const target = `${subject}${path(step.path, '?.')}`;
      if (step.body && !step.body.predicate && step.args === null) {
        return wrap(checks(parseBody(step.body), `${target}?.${step.name}`, scope, ctx));
      }
      return `Boolean(${target}?.${step.name}?.(${list(body(step, null, ctx), step.args)}))`;
    }

    case 'lib': {
      const { ref, adapter } = ctx.lib(step, ctx);
      return `Boolean(${libCall(ref, adapter, subject, body(step, null, ctx), step.args)})`;
    }
  }

  if (CAPTURE.test(step.name) && !ctx.predicates[step.name]) return `Boolean(${capture(step, ctx)}(${subject}))`;

  const op = ctx.predicates[step.name];
  if (op) {
    arity(step, op, 'args');
    arity(step, op, 'body');
    return `(${op.emit(subject, step.args, emitContext(step, op, scope, ctx))})`;
  }

  // not a predicate: preferred library (`isPlainObject`), otherwise an error with a hint
  const hit = ctx.implicit(step, ctx);
  if (hit) return `Boolean(${libCall(hit.ref, hit.adapter, subject, body(step, null, ctx), step.args)})`;
  return fail(
    `unknown check '${step.name}'${didYouMean(step.name, Object.keys(ctx.predicates))} (methods: '.${step.name}()')`,
    step,
  );
}

function shape(step, subject, scope, ctx) {
  const parts = [`${subject} != null`, `typeof ${subject} === 'object'`];
  for (const entry of parseObjectEntries(step)) {
    if (entry.spread) fail('spread is not supported in shape checks', { source: step.source, start: entry.start });
    const access = entry.ident ? `${subject}?.${entry.key}` : `${subject}?.[${entry.key}]`;
    const check = entry.steps ? checks(entry.steps, access, scope, ctx) : `${access} !== undefined`;
    if (entry.optional) parts.push(`(${access} === undefined || ${check})`);
    else if (check !== 'true') parts.push(check);
  }
  return `(${parts.join(' && ')})`;
}

// --- cmp ----------------------------------------------------------------------------------------

function cmpKind({ source, from, to }, ctx) {
  const scope = functionScope('it', false);
  const compare = (natural) => scope.helper(natural ? NATURAL : CMP);

  const terms = splitTop(source, from, to, ',')
    .filter((range) => range.from < range.to)
    .map((range) => {
      let steps = parseRange(source, range.from, range.to);
      let desc = false;
      let natural = false;
      while (steps.length && CMP_MODIFIERS.has(steps.at(-1).name) && keyword(steps.at(-1), steps.at(-1).name)) {
        const { name } = steps.at(-1);
        if (name === 'desc') desc = true;
        if (name === 'natural') natural = true;
        steps = steps.slice(0, -1);
      }
      const key = sortKey(steps, scope, ctx);
      const [x, y] = desc ? ['b', 'a'] : ['a', 'b'];
      return `${compare(natural)}(${key(x)}, ${key(y)})`;
    });

  if (!terms.length) terms.push(`${compare(false)}(a, b)`);
  return render({ params: ['a', 'b'], lines: scope.lines, expr: terms.join(' || ') });
}

// plain property paths are read directly from `a` / `b`, everything else becomes a key helper
function sortKey(steps, scope, ctx) {
  if (steps.every((step) => step.type === 'prop')) {
    const access = steps.map((step) => path(step.path, '.')).join('');
    return (base) => `${base}${access}`;
  }
  const helper = scope.bind(render(compileFn(steps, ctx)));
  return (base) => `${helper}(${base})`;
}

// --- match --------------------------------------------------------------------------------------

function matchKind({ source, from, to }, ctx) {
  const scope = functionScope('it', false);
  const ranges = splitTop(source, from, to, '|').filter((range) => range.from < range.to);
  const cases = [];
  let fallback = 'undefined';

  ranges.forEach((range, index) => {
    const [condition, value, ...rest] = splitTop(source, range.from, range.to, '->');
    if (!value || rest.length) fail('expected `checks -> pipeline`', { source, start: range.from });
    const result = lazy(parseRange(source, value.from, value.to), 'it', scope, ctx);
    const text = source.slice(condition.from, condition.to);
    if (text === '_' || text === 'else') {
      if (index !== ranges.length - 1) fail('the default case must be the last one', { source, start: range.from });
      fallback = result;
    } else {
      cases.push([checks(parseRange(source, condition.from, condition.to), 'it', scope, ctx), result]);
    }
  });

  const expr = cases.reduceRight((acc, [condition, value]) => `${condition} ? ${value} : ${acc}`, fallback);
  return render({ params: ['it'], lines: scope.lines, expr: cases.length ? `(${expr})` : expr });
}

// --- fmt ----------------------------------------------------------------------------------------

function fmtKind({ source, from, to }, ctx) {
  const scope = functionScope('it', false);
  const inner = inlineScope(scope);
  let out = '';

  for (let i = from; i < to; i++) {
    const ch = source[i];
    if ((ch === '{' || ch === '}') && source[i + 1] === ch) {
      out += ch;
      i++;
    } else if (ch === '{') {
      const end = scanGroup(source, i, to, (message, pos) => {
        throw new LsdSyntaxError(message, source, pos);
      });
      out += `\${${chain(parseRange(source, i + 1, end), 'it', inner, ctx)}}`;
      i = end;
    } else if (ch === '`' || (ch === '$' && source[i + 1] === '{')) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }

  return render({ params: ['it'], lines: scope.lines, expr: `\`${out}\`` });
}

// --- shared -------------------------------------------------------------------------------------

function emitContext(step, op, scope, ctx) {
  return { body: body(step, op, ctx), bind: scope.bind, helper: scope.helper, apply: scope.apply };
}

function body(step, op, ctx) {
  if (!step.body) return null;
  const kind = step.body.predicate ? 'is' : (op?.bodyKind ?? 'fn');
  return KIND[kind](step.body, ctx);
}

// replaces macro calls by their steps, recursively
function expand(steps, vocabulary, ctx, stack = []) {
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
    if (op.macro[0]?.type === 'params') {
      fail(`macro '${step.name}' declares params and cannot be used as a step`, step);
    }

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

    out.push(...expand(macro, vocabulary, ctx, [...stack, step.name]));
  }
  return out;
}

function capture(step, ctx) {
  if (Number(step.name.slice(1)) >= ctx.captures) fail(`unknown capture '${step.name}'`, step);
  if (step.args !== null || step.body !== null) fail('a captured function takes no arguments', step);
  return step.name;
}

const path = (keys, dot) => keys.map((key) => `${dot}${key}`).join('');
const list = (...items) => items.filter(Boolean).join(', ');
const wrap = (code) => (code.startsWith('(') || code === 'true' ? code : `(${code})`);

function mergeArgs(own, forwarded) {
  if (own && forwarded) return `${own}, ${forwarded}`;
  return own ?? forwarded;
}

function arity(step, op, key) {
  const given = key === 'args' ? step.args !== null && step.args !== '' : step.body !== null;
  const label = key === 'args' ? 'arguments' : 'a sub-pipeline';
  if (op[key] === 'required' && !given) fail(`op '${step.name}' requires ${label}`, step);
  if (op[key] === 'none' && given) fail(`op '${step.name}' takes no ${label}`, step);
}

function fail(message, at) {
  throw new LsdSyntaxError(message, at?.source ?? '', at?.start ?? 0);
}

function noLibs(step) {
  fail(`library steps are not available here (${step.lib}::${step.name})`, step);
}
