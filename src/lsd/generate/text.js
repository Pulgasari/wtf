// text grammars: lsd.fmt (value -> text) and lsd.parse (text -> object). both read text with
// `{...}` fields, `{{` / `}}` are literal braces.

import { findClose, parseRange, trimRange } from '../parse.js';
import { chain, fail, fixedScope, inlineScope, render } from './core.js';

// walks the text, calls literal(char) for plain text and field(range) for `{...}`
function scanTemplate({ source, from, to }, { literal, field }) {
  for (let i = from; i < to; i++) {
    const ch = source[i];
    if ((ch === '{' || ch === '}') && source[i + 1] === ch) {
      literal(ch);
      i++;
    } else if (ch === '{') {
      const end = findClose(source, i, to);
      field(trimRange(source, i + 1, end));
      i = end;
    } else {
      literal(ch, source[i + 1]);
    }
  }
}

// `{pipeline}` interpolates, `{}` is the value itself
export function fmtKind(range, ctx) {
  const scope = fixedScope();
  const inner = inlineScope(scope);
  let out = '';

  scanTemplate(range, {
    literal: (ch, next) => {
      out += ch === '`' || (ch === '$' && next === '{') ? `\\${ch}` : ch;
    },
    field: ({ source, from, to }) => {
      out += `\${${chain(parseRange(source, from, to), 'it', inner, ctx)}}`;
    },
  });

  return render({ lines: scope.lines, expr: `\`${out}\`` });
}

// the inverse of fmt: `{key pipeline}` captures text and runs the pipeline on it, `{}` / `{_}` skip text.
// fields whose pipeline starts with int / num / float only match numbers, which keeps them apart.
const DECIMAL = '([+-]?\\d*\\.?\\d+(?:e[+-]?\\d+)?)';
const NUMBER_GROUP = { int: '([+-]?\\d+)', num: DECIMAL, float: DECIMAL };
const FIELD_KEY = /^[A-Za-z_$][\w$]*/;

export function parseKind(range, ctx) {
  if (ctx.captures) fail('lsd.parse takes no interpolations', { source: range.source, start: range.from });
  const scope = fixedScope();
  const fields = [];
  let pattern = '';

  scanTemplate(range, {
    literal: (ch) => {
      pattern += escapeRegex(ch);
    },
    field: ({ source, from, to }) => {
      const key = FIELD_KEY.exec(source.slice(from, to))?.[0];
      if (!key || key === '_') {
        pattern += '.*?';
        return;
      }
      if (fields.some((field) => field.key === key)) fail(`duplicate field '${key}'`, { source, start: from });
      const steps = parseRange(source, from + key.length, to);
      pattern += (steps[0]?.type === 'call' && NUMBER_GROUP[steps[0].name]) || '(.*?)';
      fields.push({ key, steps });
    },
  });

  const match = scope.bind(`/^${pattern}$/s.exec(it)`);
  scope.lines.push(`if (!${match}) return null;`);
  const inner = inlineScope(scope);
  const parts = fields.map(({ key, steps }, index) => `${key}: ${chain(steps, `${match}[${index + 1}]`, inner, ctx)}`);
  return render({ lines: scope.lines, expr: `({ ${parts.join(', ')} })` });
}

const escapeRegex = (value) => value.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
