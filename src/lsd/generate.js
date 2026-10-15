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
// every factory returns the source of an arrow function. sub-grammars nest through bodies:
// `filter?[...]` is an `is` body, `order[...]` a `cmp` body and so on.

import {
  LsdSyntaxError,
  parseBody,
  parseObjectEntries,
  parseRange,
  parseTupleItems,
  splitTop,
  trimRange,
  _scanGroup as scanGroup,
} from './parse.js';
import { libCall, didYouMean } from './libs.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const CAPTURE = /^\$\d+$/;
const MAX_MACRO_DEPTH = 32;

const CMP = '(x, y) => (x < y ? -1 : x > y ? 1 : 0)';
const NATURAL = "(x, y) => String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })";
const CMP_MODIFIERS = new Set(['asc', 'desc', 'natural']);

export const KINDS = ['fn', 'is', 'cmp', 'match', 'fmt', 'parse', 'check'];

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

// the top-level steps of a fn spec with the expression after each one
export function explain(spec, options = {}) {
  const trace = [];
  const code = render(
    compileFn(parseRange(spec, 0, spec.length), context(options), (step, expr) =>
      trace.push({ step: step.source.slice(step.start, step.end), expr }),
    ),
  );
  return { code, steps: trace };
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
  parse: parseKind,
  check: checkKind,
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
  return { ...scope, reassign: false, param: scope.param === 'it' ? 'it' : null, safe, trace: null };
}

function render({ params, lines, expr }) {
  const head = `(${params.join(', ')})`;
  return lines.length ? `${head} => { ${lines.join(' ')} return ${expr}; }` : `${head} => ${expr}`;
}

// --- fn -----------------------------------------------------------------------------------------

function compileFn(steps, ctx, trace = null) {
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
function lazy(steps, subject, scope, ctx) {
  const fn = compileFn(steps, ctx);
  if (subject === 'it' && !fn.lines.length && fn.params.length === 1 && fn.params[0] === 'it') return fn.expr;
  return `${scope.bind(render(fn))}(${subject})`;
}

function chain(steps, start, scope, ctx) {
  const state = { safe: scope.safe };
  let expr = start;
  for (const step of expand(steps, ctx.vocabulary, ctx)) {
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
    case 'lib': {
      const { ref, adapter } = ctx.lib(step, ctx);
      return libCall(ref, adapter, expr, body(step, null, ctx), step.args);
    }
    case 'method':
      return `${expr}${path(step.path, dot)}${dot}${step.name}(${list(body(step, null, ctx), step.args)})`;
  }

  const op = ctx.vocabulary[step.name];
  if (op) {
    arity(step, op, 'args');
    arity(step, op, 'body');
    const input = op.ref && !IDENT.test(expr) ? scope.bind(expr) : expr;
    return op.emit(input, step.args, emitContext(step, op, scope, ctx));
  }

  if (CAPTURE.test(step.name)) return `${capture(step, ctx)}(${expr})`;

  // preferred library function, otherwise plain method call
  const callback = body(step, null, ctx);
  const hit = ctx.implicit(step, ctx);
  return hit
    ? libCall(hit.ref, hit.adapter, expr, callback, step.args)
    : `${expr}${dot}${step.name}(${list(callback, step.args)})`;
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

// --- parse --------------------------------------------------------------------------------------

// the inverse of fmt: `{key pipeline}` captures text and runs the pipeline on it, `{}` / `{_}` skip text.
// groups whose pipeline starts with int / num / float only match numbers, which keeps them apart.
const NUMBER_GROUP = { int: '([+-]?\\d+)', num: '([+-]?\\d*\\.?\\d+(?:e[+-]?\\d+)?)', float: '([+-]?\\d*\\.?\\d+(?:e[+-]?\\d+)?)' };

function parseKind({ source, from, to }, ctx) {
  if (ctx.captures) fail('lsd.parse takes no interpolations', { source, start: from });
  const scope = functionScope('it', false);
  const fields = [];
  let pattern = '';

  for (let i = from; i < to; i++) {
    const ch = source[i];
    if ((ch === '{' || ch === '}') && source[i + 1] === ch) {
      pattern += escapeRegex(ch);
      i++;
      continue;
    }
    if (ch !== '{') {
      pattern += escapeRegex(ch);
      continue;
    }

    const end = scanGroup(source, i, to, (message, pos) => fail(message, { source, start: pos }));
    const inner = trimRange(source, i + 1, end);
    const key = /^[A-Za-z_$][\w$]*/.exec(source.slice(inner.from, inner.to))?.[0];
    if (!key || key === '_') {
      pattern += '.*?';
    } else {
      if (fields.some((field) => field.key === key)) fail(`duplicate field '${key}'`, { source, start: inner.from });
      const steps = parseRange(source, inner.from + key.length, inner.to);
      const first = steps[0]?.type === 'call' && steps[0].name;
      pattern += NUMBER_GROUP[first] ?? '(.*?)';
      fields.push({ key, steps });
    }
    i = end;
  }

  const match = scope.bind(`/^${pattern}$/s.exec(it)`);
  scope.lines.push(`if (!${match}) return null;`);
  const inner = inlineScope(scope);
  const parts = fields.map(({ key, steps }, index) => `${key}: ${chain(steps, `${match}[${index + 1}]`, inner, ctx)}`);
  return render({ params: ['it'], lines: scope.lines, expr: `({ ${parts.join(', ')} })` });
}

const escapeRegex = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

// --- check --------------------------------------------------------------------------------------

// lsd.is grammar, but collects errors instead of returning a boolean:
// [{ path: 'tags[1]', expected: 'string' }, ...], empty if valid. shapes, scoped paths, `array[...]`
// and tuples are walked so the path points at the culprit, every other term reports its own text.
function checkKind(range, ctx) {
  const steps = parseBody(range);
  if (steps[0]?.type === 'params') fail('lsd.check takes no param list', steps[0]);
  const scope = functionScope('it', false);
  const statements = report(steps, 'it', [], scope, ctx, { n: 0 });
  return `(it) => { ${[...scope.lines, 'const errors = [];', ...statements, 'return errors;'].join(' ')} }`;
}

function report(steps, subject, at, scope, ctx, counter) {
  const push = (where, expected) => `errors.push({ path: ${renderPath(where)}, expected: ${JSON.stringify(expected)} });`;

  // alternatives cannot point at a single culprit: one error for the whole expression
  if (steps.some((step) => keyword(step, 'or'))) {
    const expected = steps[0].source.slice(steps[0].start, steps.at(-1).end);
    return [`if (!${checks(steps, subject, scope, ctx)}) ${push(at, expected)}`];
  }

  const label = `_c${counter.n++}`;
  const out = [];
  // a failed guard skips the remaining terms of this block
  const guard = (condition, expected) => out.push(`if (!(${condition})) { ${push(at, expected)} break ${label}; }`);
  let negate = null;

  for (const step of steps) {
    if (step.type === 'safe') continue;
    if (keyword(step, 'not')) {
      negate = negate ? null : step;
      continue;
    }
    if (negate) {
      guard(checks([negate, step], subject, scope, ctx), negate.source.slice(negate.start, step.end));
      negate = null;
      continue;
    }

    if (step.type === 'object') {
      guard(`${subject} != null && typeof ${subject} === 'object'`, 'object');
      for (const entry of parseObjectEntries(step)) {
        if (entry.spread) fail('spread is not supported in checks', { source: step.source, start: entry.start });
        const name = entry.ident ? entry.key : entry.key.slice(1, -1);
        const access = entry.ident ? `${subject}?.${entry.key}` : `${subject}?.[${entry.key}]`;
        const where = [...at, name];
        if (!entry.steps) {
          out.push(`if (${access} === undefined) ${push(where, 'defined')}`);
          continue;
        }
        const inner = report(entry.steps, access, where, scope, ctx, counter);
        out.push(entry.optional ? `if (${access} !== undefined) { ${inner.join(' ')} }` : inner.join(' '));
      }
    } else if (step.type === 'method' && step.body && !step.body.predicate && step.args === null) {
      const target = `${subject}${path(step.path, '?.')}?.${step.name}`;
      out.push(...report(parseBody(step.body), target, [...at, ...step.path, step.name], scope, ctx, counter));
    } else if (step.type === 'call' && step.name === 'array' && step.body && !ctx.predicates.array?.macro) {
      guard(`Array.isArray(${subject})`, 'array');
      const index = `_i${counter.n++}`;
      const inner = report(parseBody(step.body), `${subject}[${index}]`, [...at, { index }], scope, ctx, counter);
      out.push(`for (let ${index} = 0; ${index} < ${subject}.length; ${index}++) { ${inner.join(' ')} }`);
    } else if (step.type === 'tuple') {
      const { items, single } = parseTupleItems(step);
      if (single) {
        out.push(...report(items[0] ?? [], subject, at, scope, ctx, counter));
        continue;
      }
      guard(`Array.isArray(${subject}) && ${subject}.length === ${items.length}`, `tuple of ${items.length}`);
      items.forEach((item, index) => out.push(...report(item, `${subject}[${index}]`, [...at, { index }], scope, ctx, counter)));
    } else {
      guard(checks([step], subject, scope, ctx), step.source.slice(step.start, step.end));
    }
  }

  if (negate) fail("dangling 'not'", negate);
  return out.length ? [`${label}: { ${out.join(' ')} }`] : [];
}

// ['user', 'tags', { index: '_i0' }] -> `user.tags[${_i0}]`
function renderPath(segments) {
  let dynamic = false;
  const text = segments
    .map((segment, position) => {
      if (typeof segment === 'object') {
        dynamic = true;
        return `[\${${segment.index}}]`;
      }
      return position ? `.${segment}` : segment;
    })
    .join('');
  return dynamic ? `\`${text}\`` : JSON.stringify(text);
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
