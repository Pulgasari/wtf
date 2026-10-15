// spec grammar (whitespace separated steps, applied left to right):
//
//   name          vocabulary op, falls back to method call `v.name()`
//   name(args)    vocabulary op with args, falls back to `v.name(args)`
//   .name()       explicit method call, bypasses the vocabulary
//   .name(args)   explicit method call with args
//   .a.b          property access
//
// dotted steps may follow the previous step without whitespace: `split(',').length`
// args are raw javascript source and are injected verbatim into the generated code.

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
const SPACE = /\s/;

// chars after which a `/` inside args starts a regex literal rather than a division
const REGEX_PREFIX = new Set(['(', ',', '[', '{', '=', ':', '!', '&', '|', '?', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

export class LsdSyntaxError extends SyntaxError {
  constructor(message, spec, pos) {
    super(`${message}\n  ${spec}\n  ${' '.repeat(pos)}^`);
    this.name = 'LsdSyntaxError';
    this.reason = message;
    this.spec = spec;
    this.pos = pos;
  }
}

export function parse(spec) {
  if (typeof spec !== 'string') {
    throw new TypeError(`lsd: spec must be a string, got ${typeof spec}`);
  }

  const steps = [];
  let i = 0;

  const fail = (message, pos = i) => {
    throw new LsdSyntaxError(message, spec, pos);
  };

  const readIdent = () => {
    const start = i;
    if (!IDENT_START.test(spec[i] ?? '')) fail('expected identifier');
    while (i < spec.length && IDENT_PART.test(spec[i])) i++;
    return spec.slice(start, i);
  };

  while (i < spec.length) {
    if (SPACE.test(spec[i])) {
      i++;
      continue;
    }

    const start = i;

    if (spec[i] === '.') {
      // `.a.b` -> property path, `.a.b()` -> method call on `.a`
      const path = [];
      while (spec[i] === '.') {
        i++;
        path.push(readIdent());
      }
      if (spec[i] === '(') {
        const end = scanArgs(spec, i, fail);
        const name = path.pop();
        if (path.length) steps.push({ type: 'prop', path, start });
        steps.push({ type: 'method', name, args: spec.slice(i + 1, end).trim(), start });
        i = end + 1;
      } else {
        steps.push({ type: 'prop', path, start });
      }
    } else {
      const name = readIdent();
      let args = null;
      if (spec[i] === '(') {
        const end = scanArgs(spec, i, fail);
        args = spec.slice(i + 1, end).trim();
        i = end + 1;
      }
      steps.push({ type: 'call', name, args, start });
    }

    // dotted steps may chain directly: `.trim().length`, `split(',').length`
    if (i < spec.length && !SPACE.test(spec[i]) && spec[i] !== '.') {
      fail(`unexpected character '${spec[i]}', steps must be separated by whitespace`);
    }
  }

  return steps;
}

// returns the index of the `)` matching the `(` at `open`.
// aware of strings, template literals and regex literals, so `split(') ')` works.
function scanArgs(spec, open, fail) {
  let depth = 0;
  let prev = '(';

  for (let i = open; i < spec.length; i++) {
    const ch = spec[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(spec, i, ch, fail);
      prev = ch;
      continue;
    }

    if (ch === '/' && REGEX_PREFIX.has(prev)) {
      i = skipRegex(spec, i, fail);
      prev = '/';
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        if (ch !== ')') fail(`unbalanced '${ch}'`, i);
        return i;
      }
    }

    if (!SPACE.test(ch)) prev = ch;
  }

  return fail('unterminated argument list', open);
}

function skipQuoted(spec, start, quote, fail) {
  for (let i = start + 1; i < spec.length; i++) {
    if (spec[i] === '\\') i++;
    else if (spec[i] === quote) return i;
  }
  return fail('unterminated string', start);
}

function skipRegex(spec, start, fail) {
  let inClass = false;
  for (let i = start + 1; i < spec.length; i++) {
    const ch = spec[i];
    if (ch === '\\') i++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      while (i + 1 < spec.length && /[a-z]/.test(spec[i + 1])) i++;
      return i;
    }
  }
  return fail('unterminated regex', start);
}
