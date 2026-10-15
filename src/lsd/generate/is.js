// lsd.is: checks are and-ed, `or` separates groups, `not` negates the next term.

import { parseBody, parseObjectEntries, parseTupleItems } from '../parse.js';
import { didYouMean } from '../libs.js';
import {
  capture,
  checkArity,
  emitContext,
  entryAccess,
  expand,
  fail,
  fixedScope,
  isCapture,
  isScopedPath,
  keyword,
  libStep,
  list,
  body,
  path,
  render,
  withoutParams,
  wrap,
} from './core.js';

export function isKind(range, ctx) {
  const steps = withoutParams(parseBody(range), 'lsd.is');
  const scope = fixedScope();
  return render({ lines: scope.lines, expr: checks(steps, 'it', scope, ctx) });
}

// boolean expression for `subject`
export function checks(steps, subject, scope, ctx) {
  const groups = [[]];
  let negate = null;

  for (const step of expand(steps, ctx.predicates)) {
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

// a single check, always a primary expression
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
      if (isScopedPath(step)) return wrap(checks(parseBody(step.body), `${target}?.${step.name}`, scope, ctx));
      return `Boolean(${target}?.${step.name}?.(${list(body(step, null, ctx), step.args)}))`;
    }

    case 'lib':
      return `Boolean(${libStep(ctx.lib(step, ctx), step, subject, ctx)})`;
  }

  const op = ctx.predicates[step.name];
  if (op) {
    checkArity(step, op);
    return `(${op.emit(subject, step.args, emitContext(step, op, scope, ctx))})`;
  }
  if (isCapture(step.name)) return `Boolean(${capture(step, ctx)}(${subject}))`;

  // not a check: preferred library (`isPlainObject`), otherwise an error with a hint
  const hit = ctx.implicit(step, ctx);
  if (hit) return `Boolean(${libStep(hit, step, subject, ctx)})`;
  return fail(
    `unknown check '${step.name}'${didYouMean(step.name, Object.keys(ctx.predicates))} (methods: '.${step.name}()')`,
    step,
  );
}

function shape(step, subject, scope, ctx) {
  const parts = [`${subject} != null`, `typeof ${subject} === 'object'`];
  for (const entry of parseObjectEntries(step)) {
    if (entry.spread) fail('spread is not supported in shape checks', { source: step.source, start: entry.start });
    const access = entryAccess(subject, entry);
    const check = entry.steps ? checks(entry.steps, access, scope, ctx) : `${access} !== undefined`;
    if (entry.optional) parts.push(`(${access} === undefined || ${check})`);
    else if (check !== 'true') parts.push(check);
  }
  return `(${parts.join(' && ')})`;
}
