// lsd.cmp: comma separated sort keys, each a pipeline with optional asc / desc / natural.

import { parseRange, splitTop } from '../parse.js';
import { compileFn, fixedScope, keyword, path, render } from './core.js';

const CMP = '(x, y) => (x < y ? -1 : x > y ? 1 : 0)';
const NATURAL = "(x, y) => String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })";
const MODIFIERS = new Set(['asc', 'desc', 'natural']);

export function cmpKind({ source, from, to }, ctx) {
  const scope = fixedScope();
  const compare = (natural) => scope.helper(natural ? NATURAL : CMP);

  const terms = splitTop(source, from, to, ',')
    .filter((range) => range.from < range.to)
    .map((range) => {
      const steps = parseRange(source, range.from, range.to);
      const modifiers = new Set();
      while (steps.length && MODIFIERS.has(steps.at(-1).name) && keyword(steps.at(-1), steps.at(-1).name)) {
        modifiers.add(steps.pop().name);
      }
      const key = sortKey(steps, scope, ctx);
      const [x, y] = modifiers.has('desc') ? ['b', 'a'] : ['a', 'b'];
      return `${compare(modifiers.has('natural'))}(${key(x)}, ${key(y)})`;
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
