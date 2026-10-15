import { LsdSyntaxError } from './parse.js';
import { libCall } from './libs.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const CAPTURE = /^\$\d+$/;
const MAX_MACRO_DEPTH = 32;

/**
 * turns parsed steps into the source of an arrow function.
 * single expression if possible, block body with temp consts if an op binds something.
 *
 * @param {object} options
 * @param {object} options.vocabulary  from createVocabulary
 * @param {string} [options.spec]      original spec, for error messages
 * @param {(step, ctx) => { ref: string, adapter: object }} [options.lib]
 *        resolves a `lib::name` step to an expression referencing the function. differs between
 *        runtime (registered objects) and compiler (generated imports).
 * @param {(step, ctx) => { ref: string, adapter: object } | null} [options.implicit]
 *        resolves a name that is not in the vocabulary against preferred libraries, null -> method call.
 * @param {number} [options.captures]  number of `$n` captures in scope (tagged templates)
 */
export function generate(steps, options = {}) {
  const ctx = {
    vocabulary: options.vocabulary ?? {},
    spec: options.spec ?? '',
    lib: options.lib ?? noLibs,
    implicit: options.implicit ?? (() => null),
    captures: options.captures ?? 0,
  };
  return fnSource(steps, ctx);
}

function fnSource(input, ctx) {
  let params = ['it'];
  let steps = input;
  if (input[0]?.type === 'params') {
    params = input[0].names;
    steps = input.slice(1);
  }
  // the pipeline value
  const param = params.includes('it') ? 'it' : params[0];

  const lines = [];
  let temp = 0;
  const bind = (code) => {
    const id = `_${temp++}`;
    lines.push(`const ${id} = ${code};`);
    return id;
  };

  let expr = param;

  for (const step of expand(steps, ctx, [])) {
    if (step.type === 'prop') {
      expr += step.path.map((key) => `.${key}`).join('');
      continue;
    }

    if (step.type === 'expr') {
      // `it` has to be the current value, so materialize it into the param
      if (expr !== param) lines.push(`${param} = ${expr};`);
      expr = `(${step.code})`;
      continue;
    }

    const body = step.body ? fnSource(step.body, ctx) : null;

    if (step.type === 'lib') {
      const { ref, adapter } = ctx.lib(step, ctx);
      expr = libCall(ref, adapter, expr, body, step.args);
      continue;
    }

    const op = step.type === 'call' ? ctx.vocabulary[step.name] : undefined;

    if (!op && step.type === 'call' && CAPTURE.test(step.name)) {
      if (Number(step.name.slice(1)) >= ctx.captures) fail(`unknown capture '${step.name}'`, ctx, step);
      if (step.args !== null || step.body !== null) fail(`a captured function takes no arguments`, ctx, step);
      expr = `${step.name}(${expr})`;
      continue;
    }

    if (!op) {
      const hit = step.type === 'call' ? ctx.implicit(step, ctx) : null;
      // preferred library function, otherwise plain method call
      expr = hit
        ? libCall(hit.ref, hit.adapter, expr, body, step.args)
        : `${expr}.${step.name}(${[body, step.args].filter(Boolean).join(', ')})`;
      continue;
    }

    arity(step, op, 'args', ctx);
    arity(step, op, 'body', ctx);

    if (op.ref && !IDENT.test(expr)) expr = bind(expr);
    expr = op.emit(expr, step.args, { body, bind });
  }

  const head = params.length === 1 ? `(${params[0]})` : `(${params.join(', ')})`;
  if (!lines.length) return `${head} => ${expr}`;
  return `${head} => { ${lines.join(' ')} return ${expr}; }`;
}

// replaces macro calls by their steps, recursively
function expand(steps, ctx, stack) {
  const out = [];
  for (const step of steps) {
    const op = step.type === 'call' ? ctx.vocabulary[step.name] : undefined;
    if (!op?.macro) {
      out.push(step);
      continue;
    }

    if (stack.includes(step.name) || stack.length > MAX_MACRO_DEPTH) {
      fail(`recursive macro '${[...stack, step.name].join(' -> ')}'`, ctx, step);
    }
    if (op.macro[0]?.type === 'params') {
      fail(`macro '${step.name}' declares params and cannot be used as a step`, ctx, step);
    }

    let macro = op.macro;
    if (step.args !== null || step.body !== null) {
      // forward args / body into a single-step macro
      const [only] = macro;
      if (macro.length !== 1 || only.type === 'prop' || only.type === 'expr') {
        fail(`macro '${step.name}' (${op.source}) takes no arguments`, ctx, step);
      }
      if (only.body && step.body) fail(`macro '${step.name}' already has a sub-pipeline`, ctx, step);
      macro = [{ ...only, args: mergeArgs(only.args, step.args), body: only.body ?? step.body }];
    }

    // positions inside the macro source are meaningless for the caller, point at the call site
    const located = macro.map((inner) => ({ ...inner, start: step.start }));
    out.push(...expand(located, ctx, [...stack, step.name]));
  }
  return out;
}

function mergeArgs(own, forwarded) {
  if (own && forwarded) return `${own}, ${forwarded}`;
  return own ?? forwarded;
}

function arity(step, op, key, ctx) {
  const given = key === 'args' ? step.args !== null && step.args !== '' : step.body !== null;
  const label = key === 'args' ? 'arguments' : 'a sub-pipeline';
  if (op[key] === 'required' && !given) fail(`op '${step.name}' requires ${label}`, ctx, step);
  if (op[key] === 'none' && given) fail(`op '${step.name}' takes no ${label}`, ctx, step);
}

function fail(message, ctx, step) {
  throw new LsdSyntaxError(message, ctx.spec, step.start);
}

function noLibs(step, ctx) {
  fail(`library steps are not available here (${step.lib}::${step.name})`, ctx, step);
}
