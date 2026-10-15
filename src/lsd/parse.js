// step grammar, shared by every factory (fn, is, cmp, match, fmt). whitespace separated steps:
//
//   name            vocabulary op, falls back to method call `it.name()`
//   name(args)      vocabulary op with args, falls back to `it.name(args)`
//   name[spec]      op with a sub-pipeline, falls back to `it.name((it) => ...)`
//   name?[checks]   op with a predicate callback (lsd.is grammar): `filter?[string filled]`
//   lib::name       function from a utility library, e.g. `lodash::kebabCase`
//   .name()         explicit method call, bypasses the vocabulary
//   .a.b            property access
//   (expr)          raw javascript expression, `it` is the current value: `(it + 'px')`
//   { k: spec }     object builder (fn) / shape check (is)
//   [a, b]          tuple builder (fn) / tuple check or group (is)
//   ?               safe mode from here on: property access and method calls use `?.`
//   $0              captured value from a tagged template
//
// a pipeline may start with a param list: `acc it => (acc + it)`. the pipeline runs on `it`
// if it is one of the params, otherwise on the first one. without a list the only param is `it`.
//
// `(args)` and `[spec]` can be combined on every call-like step: `reduce[...](0)`, in any order.
// dotted steps may follow the previous step without whitespace: `split(',').length`.
// args are raw javascript source and are injected verbatim into the generated code.
//
// bracket contents (bodies, objects, tuples) are kept as ranges { source, from, to }, the factory
// that consumes them decides about their grammar. every step carries its `source` and `start`
// so errors point into the right string, even for macros.

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
const SPACE = /\s/;

const CLOSE = { '(': ')', '[': ']', '{': '}' };
const PARAMS = /^\s*([A-Za-z_$][\w$]*(?:\s*,?\s*[A-Za-z_$][\w$]*)*)\s*=>/;

// chars after which a `/` starts a regex literal rather than a division
const REGEX_PREFIX = new Set(['(', ',', '[', '{', '=', ':', '!', '&', '|', '?', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

export class LsdSyntaxError extends SyntaxError {
  constructor(message, spec, pos) {
    super(`${message}\n  ${spec}\n  ${' '.repeat(Math.max(pos, 0))}^`);
    this.name = 'LsdSyntaxError';
    this.reason = message;
    this.spec = spec;
    this.pos = pos;
  }
}

// tagged template parts -> spec, interpolations become captures `$0`, `$1`, ...
// raw parts are used so regex escapes survive: lsd.fn`replace(/\s+/g, '-')`.
// in fmt text a capture is a value, so it becomes an interpolation `{($0)}`.
export function joinTemplate(raw, kind = 'fn') {
  const capture = (index) => (kind === 'fmt' ? `{($${index})}` : `$${index}`);
  return raw.map((part, index) => (index ? `${capture(index - 1)}${part}` : part)).join('');
}

export function parse(spec) {
  if (typeof spec !== 'string') {
    throw new TypeError(`lsd: spec must be a string, got ${typeof spec}`);
  }
  return parseRange(spec, 0, spec.length);
}

export function parseBody(body) {
  return parseRange(body.source, body.from, body.to);
}

// parses source[from, to) into steps
export function parseRange(source, from, to) {
  const steps = [];
  let i = from;

  const fail = (message, pos = i) => {
    throw new LsdSyntaxError(message, source, pos);
  };

  const readIdent = () => {
    const start = i;
    if (i >= to || !IDENT_START.test(source[i])) fail('expected identifier');
    while (i < to && IDENT_PART.test(source[i])) i++;
    return source.slice(start, i);
  };

  const group = (open) => {
    const end = scanGroup(source, open, to, fail);
    return { source, from: open + 1, to: end };
  };

  // optional `(args)` and `[spec]` / `?[checks]` suffixes, at most one of each
  const readSuffixes = (step) => {
    for (;;) {
      if (source[i] === '(') {
        if (step.args !== null) fail('duplicate argument list');
        const { from: a, to: b } = group(i);
        step.args = source.slice(a, b).trim();
        i = b + 1;
      } else if (source[i] === '[' || (source[i] === '?' && source[i + 1] === '[' && i + 1 < to)) {
        if (step.body !== null) fail('duplicate sub-pipeline');
        const predicate = source[i] === '?';
        if (predicate) i++;
        step.body = { ...group(i), predicate };
        i = step.body.to + 1;
      } else {
        return step;
      }
    }
  };

  const head = PARAMS.exec(source.slice(from, to));
  if (head) {
    const names = head[1].split(/[\s,]+/);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) fail(`duplicate param '${duplicate}'`, from);
    steps.push({ type: 'params', names, source, start: from + head[0].indexOf(head[1]) });
    i = from + head[0].length;
  }

  while (i < to) {
    if (SPACE.test(source[i])) {
      i++;
      continue;
    }

    const start = i;
    const ch = source[i];

    if (ch === '(') {
      const range = group(i);
      const code = source.slice(range.from, range.to).trim();
      if (!code) fail('empty expression');
      steps.push({ type: 'expr', code, source, start });
      i = range.to + 1;
    } else if (ch === '{' || ch === '[') {
      const range = group(i);
      steps.push({ type: ch === '{' ? 'object' : 'tuple', ...range, start });
      i = range.to + 1;
    } else if (ch === '?' && (i + 1 >= to || SPACE.test(source[i + 1]) || source[i + 1] === '.')) {
      steps.push({ type: 'safe', source, start });
      i++;
    } else if (ch === '.') {
      // `.a.b` -> property path, `.a.b()` / `.a.b[...]` -> method `b` on path `a`
      const path = [];
      while (i < to && source[i] === '.') {
        i++;
        path.push(readIdent());
      }
      if (source[i] === '(' || source[i] === '[' || (source[i] === '?' && source[i + 1] === '[')) {
        const name = path.pop();
        steps.push(readSuffixes({ type: 'method', path, name, args: null, body: null, source, start }));
      } else {
        steps.push({ type: 'prop', path, source, start });
      }
    } else {
      const name = readIdent();
      if (source.startsWith('::', i) && i + 2 < to) {
        i += 2;
        const fn = readIdent();
        steps.push(readSuffixes({ type: 'lib', lib: name, name: fn, args: null, body: null, source, start }));
      } else {
        steps.push(readSuffixes({ type: 'call', name, args: null, body: null, source, start }));
      }
    }

    if (i < to && !SPACE.test(source[i]) && source[i] !== '.') {
      fail(`unexpected character '${source[i]}', steps must be separated by whitespace`);
    }
  }

  return steps;
}

// splits source[from, to) at top-level occurrences of `separator`, ignoring brackets, strings and regexes.
// `|` never matches inside `||`. returns trimmed ranges.
export function splitTop(source, from, to, separator) {
  const parts = [];
  const fail = (message, pos) => {
    throw new LsdSyntaxError(message, source, pos);
  };
  let start = from;
  let prev = ',';

  for (let i = from; i < to; i++) {
    const ch = source[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(source, i, to, ch, fail);
      prev = ch;
      continue;
    }
    if (ch === '/' && REGEX_PREFIX.has(prev)) {
      i = skipRegex(source, i, to, fail);
      prev = '/';
      continue;
    }
    if (CLOSE[ch]) {
      i = scanGroup(source, i, to, fail);
      prev = CLOSE[ch];
      continue;
    }
    if (
      source.startsWith(separator, i) &&
      !(separator === '|' && (source[i + 1] === '|' || source[i - 1] === '|'))
    ) {
      parts.push(trimRange(source, start, i));
      i += separator.length - 1;
      start = i + 1;
      prev = ',';
      continue;
    }
    if (!SPACE.test(ch)) prev = ch;
  }

  parts.push(trimRange(source, start, to));
  return parts;
}

export function trimRange(source, from, to) {
  while (from < to && SPACE.test(source[from])) from++;
  while (to > from && SPACE.test(source[to - 1])) to--;
  return { source, from, to };
}

const isEmpty = (range) => range.from >= range.to;

// `{ key: spec, key?: spec, key, 'quoted key': spec, ...spec }` -> entries
export function parseObjectEntries({ source, from, to }) {
  const entries = [];
  for (const range of splitTop(source, from, to, ',')) {
    if (isEmpty(range)) continue;
    const text = source.slice(range.from, range.to);

    if (text.startsWith('...')) {
      entries.push({ spread: true, steps: parseRange(source, range.from + 3, range.to), start: range.from });
      continue;
    }

    const match = /^(?:([A-Za-z_$][\w$]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))\s*(\?)?\s*(:)?/.exec(text);
    if (!match || (!match[4] && match[0].length !== text.length)) {
      throw new LsdSyntaxError('expected `key: spec`, `key` or `...spec`', source, range.from);
    }
    const [head, ident, quoted, optional, colon] = match;
    entries.push({
      spread: false,
      key: ident ?? quoted,
      ident: Boolean(ident),
      optional: Boolean(optional),
      steps: colon ? parseRange(source, range.from + head.length, range.to) : null,
      start: range.from,
    });
  }
  return entries;
}

// `[a, b]` -> list of step lists, `single` if there was no top-level comma
export function parseTupleItems({ source, from, to }) {
  const ranges = splitTop(source, from, to, ',');
  const items = ranges.filter((range) => !isEmpty(range)).map((range) => parseRange(source, range.from, range.to));
  return { items, single: ranges.length === 1 };
}

// returns the index of the bracket matching the one at `open`.
// aware of strings, template literals and regex literals, so `split(') ')` works.
function scanGroup(source, open, to, fail) {
  const stack = [];
  let prev = source[open];

  for (let i = open; i < to; i++) {
    const ch = source[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(source, i, to, ch, fail);
      prev = ch;
      continue;
    }

    if (ch === '/' && REGEX_PREFIX.has(prev)) {
      i = skipRegex(source, i, to, fail);
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

  const what = { '(': 'argument list', '[': 'sub-pipeline', '{': 'object' }[source[open]];
  return fail(`unterminated ${what}`, open);
}

function skipQuoted(source, start, to, quote, fail) {
  for (let i = start + 1; i < to; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i;
  }
  return fail('unterminated string', start);
}

function skipRegex(source, start, to, fail) {
  let inClass = false;
  for (let i = start + 1; i < to; i++) {
    const ch = source[i];
    if (ch === '\\') i++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      while (i + 1 < to && /[a-z]/.test(source[i + 1])) i++;
      return i;
    }
  }
  return fail('unterminated regex', start);
}

export { scanGroup as _scanGroup };
