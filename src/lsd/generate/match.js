// lsd.match: `checks -> pipeline` cases separated by `|`, `_` / `else` is the default.

import { parseRange, splitTop } from '../parse.js';
import { fail, fixedScope, lazy, render } from './core.js';
import { checks } from './is.js';

export function matchKind({ source, from, to }, ctx) {
  const scope = fixedScope();
  const ranges = splitTop(source, from, to, '|').filter((range) => range.from < range.to);
  const cases = [];
  let fallback = 'undefined';

  ranges.forEach((range, index) => {
    const [condition, value, ...rest] = splitTop(source, range.from, range.to, '->');
    if (!value || rest.length) fail('expected `checks -> pipeline`', { source, start: range.from });
    const result = lazy(parseRange(source, value.from, value.to), 'it', scope, ctx);
    const label = source.slice(condition.from, condition.to);
    if (label !== '_' && label !== 'else') {
      cases.push([checks(parseRange(source, condition.from, condition.to), 'it', scope, ctx), result]);
    } else if (index === ranges.length - 1) {
      fallback = result;
    } else {
      fail('the default case must be the last one', { source, start: range.from });
    }
  });

  // a chain of ternaries
  const expr = cases.reduceRight((acc, [condition, value]) => `${condition} ? ${value} : ${acc}`, fallback);
  return render({ lines: scope.lines, expr: cases.length ? `(${expr})` : expr });
}
