// lsd.check: is grammar, but collects errors instead of returning a boolean:
// [{ path: 'tags[1]', expected: 'string' }, ...], empty if valid. shapes, scoped paths, `array[...]`
// and tuples are walked so the path points at the culprit, every other term reports its own text.

import { parseBody, parseObjectEntries, parseTupleItems } from '../parse.js';
import { entryAccess, fail, fixedScope, isScopedPath, keyword, path, text, withoutParams } from './core.js';
import { checks } from './is.js';

export function checkKind(range, ctx) {
  const steps = withoutParams(parseBody(range), 'lsd.check');
  const scope = fixedScope();
  const statements = report(steps, 'it', [], scope, ctx, { n: 0 });
  return `(it) => { ${[...scope.lines, 'const errors = [];', ...statements, 'return errors;'].join(' ')} }`;
}

const push = (where, expected) => `errors.push({ path: ${renderPath(where)}, expected: ${JSON.stringify(expected)} });`;

// statements for `steps` on `subject`, `at` is the path so far
function report(steps, subject, at, scope, ctx, counter) {
  const nested = (inner, innerSubject, where) => report(inner, innerSubject, where, scope, ctx, counter);

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
    } else if (step.type === 'object') {
      guard(`${subject} != null && typeof ${subject} === 'object'`, 'object');
      for (const entry of parseObjectEntries(step)) {
        if (entry.spread) fail('spread is not supported in checks', { source: step.source, start: entry.start });
        const access = entryAccess(subject, entry);
        const where = [...at, entry.ident ? entry.key : entry.key.slice(1, -1)];
        if (!entry.steps) {
          out.push(`if (${access} === undefined) ${push(where, 'defined')}`);
          continue;
        }
        const inner = nested(entry.steps, access, where).join(' ');
        out.push(entry.optional ? `if (${access} !== undefined) { ${inner} }` : inner);
      }
    } else if (isScopedPath(step)) {
      const target = `${subject}${path(step.path, '?.')}?.${step.name}`;
      out.push(...nested(parseBody(step.body), target, [...at, ...step.path, step.name]));
    } else if (step.type === 'call' && step.name === 'array' && step.body && !ctx.predicates.array?.macro) {
      guard(`Array.isArray(${subject})`, 'array');
      const index = `_i${counter.n++}`;
      const inner = nested(parseBody(step.body), `${subject}[${index}]`, [...at, { index }]).join(' ');
      out.push(`for (let ${index} = 0; ${index} < ${subject}.length; ${index}++) { ${inner} }`);
    } else if (step.type === 'tuple') {
      const { items, single } = parseTupleItems(step);
      if (single) {
        out.push(...nested(items[0] ?? [], subject, at));
        continue;
      }
      guard(`Array.isArray(${subject}) && ${subject}.length === ${items.length}`, `tuple of ${items.length}`);
      items.forEach((item, index) => out.push(...nested(item, `${subject}[${index}]`, [...at, { index }])));
    } else {
      guard(checks([step], subject, scope, ctx), text(step));
    }
  }

  if (negate) fail("dangling 'not'", negate);
  return out.length ? [`${label}: { ${out.join(' ')} }`] : [];
}

// ['user', 'tags', { index: '_i0' }] -> `user.tags[${_i0}]`
function renderPath(segments) {
  const dynamic = segments.some((segment) => typeof segment === 'object');
  const joined = segments
    .map((segment, position) => {
      if (typeof segment === 'object') return `[\${${segment.index}}]`;
      return position ? `.${segment}` : segment;
    })
    .join('');
  return dynamic ? `\`${joined}\`` : JSON.stringify(joined);
}
