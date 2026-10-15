// spec grammar (whitespace separated steps, applied left to right):
//
//   name            vocabulary op, falls back to method call `v.name()`
//   name(args)      vocabulary op with args, falls back to `v.name(args)`
//   name[spec]      op with a sub-pipeline, falls back to `v.name((v) => ...)`
//   lib::name       function from a utility library, e.g. `lodash::kebabCase`
//   .name()         explicit method call, bypasses the vocabulary
//   .name[spec]     explicit method call with a sub-pipeline as callback
//   .a.b            property access
//
// `(args)` and `[spec]` can be combined on every call-like step: `reduce[...](0)`, in any order.
// dotted steps may follow the previous step without whitespace: `split(',').length`.
// args are raw javascript source and are injected verbatim into the generated code.
//
// steps: { type: 'call' | 'method' | 'lib' | 'prop', name?, lib?, path?, args: string | null, body: steps | null, start }

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
const SPACE = /\s/;

const CLOSE = { '(': ')', '[': ']', '{': '}' };

// chars after which a `/` starts a regex literal rather than a division
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
  return parseRange(spec, 0, spec.length);
}

// parses spec[from, to). positions in steps and errors always refer to the full spec.
function parseRange(spec, from, to) {
  const steps = [];
  let i = from;

  const fail = (message, pos = i) => {
    throw new LsdSyntaxError(message, spec, pos);
  };

  const readIdent = () => {
    const start = i;
    if (i >= to || !IDENT_START.test(spec[i])) fail('expected identifier');
    while (i < to && IDENT_PART.test(spec[i])) i++;
    return spec.slice(start, i);
  };

  // optional `(args)` and `[spec]` suffixes, at most one of each
  const readSuffixes = (step) => {
    while (i < to && (spec[i] === '(' || spec[i] === '[')) {
      const open = spec[i];
      const key = open === '(' ? 'args' : 'body';
      if (step[key] !== null) fail(`duplicate ${open === '(' ? 'argument list' : 'sub-pipeline'}`);
      const end = scanGroup(spec, i, to, fail);
      step[key] = open === '(' ? spec.slice(i + 1, end).trim() : parseRange(spec, i + 1, end);
      i = end + 1;
    }
    return step;
  };

  while (i < to) {
    if (SPACE.test(spec[i])) {
      i++;
      continue;
    }

    const start = i;

    if (spec[i] === '.') {
      // `.a.b` -> property path, `.a.b()` / `.a.b[...]` -> method call on `.a`
      const path = [];
      while (i < to && spec[i] === '.') {
        i++;
        path.push(readIdent());
      }
      if (spec[i] === '(' || spec[i] === '[') {
        const name = path.pop();
        if (path.length) steps.push({ type: 'prop', path, start });
        steps.push(readSuffixes({ type: 'method', name, args: null, body: null, start }));
      } else {
        steps.push({ type: 'prop', path, start });
      }
    } else {
      const name = readIdent();
      if (spec.startsWith('::', i) && i + 2 <= to) {
        i += 2;
        const fn = readIdent();
        steps.push(readSuffixes({ type: 'lib', lib: name, name: fn, args: null, body: null, start }));
      } else {
        steps.push(readSuffixes({ type: 'call', name, args: null, body: null, start }));
      }
    }

    if (i < to && !SPACE.test(spec[i]) && spec[i] !== '.') {
      fail(`unexpected character '${spec[i]}', steps must be separated by whitespace`);
    }
  }

  return steps;
}

// returns the index of the bracket matching the one at `open`.
// aware of strings, template literals and regex literals, so `split(') ')` works.
function scanGroup(spec, open, to, fail) {
  const stack = [];
  let prev = spec[open];

  for (let i = open; i < to; i++) {
    const ch = spec[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(spec, i, to, ch, fail);
      prev = ch;
      continue;
    }

    if (ch === '/' && REGEX_PREFIX.has(prev)) {
      i = skipRegex(spec, i, to, fail);
      prev = '/';
      continue;
    }

    if (CLOSE[ch]) stack.push(CLOSE[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) fail(`unbalanced '${ch}'`, i);
      if (!stack.length) return i;
    }

    if (!SPACE.test(ch)) prev = ch;
  }

  return fail(spec[open] === '(' ? 'unterminated argument list' : 'unterminated sub-pipeline', open);
}

function skipQuoted(spec, start, to, quote, fail) {
  for (let i = start + 1; i < to; i++) {
    if (spec[i] === '\\') i++;
    else if (spec[i] === quote) return i;
  }
  return fail('unterminated string', start);
}

function skipRegex(spec, start, to, fail) {
  let inClass = false;
  for (let i = start + 1; i < to; i++) {
    const ch = spec[i];
    if (ch === '\\') i++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      while (i + 1 < to && /[a-z]/.test(spec[i + 1])) i++;
      return i;
    }
  }
  return fail('unterminated regex', start);
}
