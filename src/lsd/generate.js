import { LsdSyntaxError } from './parse.js';
import { libCall } from './libs.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_MACRO_DEPTH = 32;

/**
 * turns parsed steps into the source of an arrow function.
 * single expression if possible, block body with temp consts if an op binds something.
 *
 * @param {object} options
 * @param {object} options.vocabulary  from createVocabulary
 * @param {string} [options.spec]      original spec, for error messages
 * @param {(step) => { ref: string, adapter: object }} [options.lib]
 *        resolves a `lib::name` step to an expression referencing the function. differs between
 *        runtime (registered objects) and compiler (generated imports).
 */
export function generate(steps, options = {}) {
  const ctx = {
    vocabulary: options.vocabulary ?? {},
    spec: options.spec ?? '',
    param: options.param ?? 'v',
    lib: options.lib ?? noLibs,
  };
  return fnSource(steps, ctx);
}

function fnSource(steps, ctx) {
  const lines = [];
  let temp = 0;
  const bind = (code) => {
    const id = `_${temp++}`;
    lines.push(`const ${id} = ${code};`);
    return id;
  };

  let expr = ctx.param;

  for (const step of expand(steps, ctx, [])) {
    if (step.type === 'prop') {
      expr += step.path.map((key) => `.${key}`).join('');
      continue;
    }

    const body = step.body ? fnSource(step.body, ctx) : null;

    if (step.type === 'lib') {
      const { ref, adapter } = ctx.lib(step, ctx);
      expr = libCall(ref, adapter, expr, body, step.args);
      continue;
    }

    const op = step.type === 'call' ? ctx.vocabulary[step.name] : undefined;

    // explicit `.name()` or not in the vocabulary -> plain method call
    if (!op) {
      expr += `.${step.name}(${[body, step.args].filter(Boolean).join(', ')})`;
      continue;
    }

    arity(step, op, 'args', ctx);
    arity(step, op, 'body', ctx);

    if (op.ref && !IDENT.test(expr)) expr = bind(expr);
    expr = op.emit(expr, step.args, { body, bind });
  }

  if (!lines.length) return `(${ctx.param}) => ${expr}`;
  return `(${ctx.param}) => { ${lines.join(' ')} return ${expr}; }`;
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

    let macro = op.macro;
    if (step.args !== null || step.body !== null) {
      // forward args / body into a single-step macro
      const [only] = macro;
      if (macro.length !== 1 || only.type === 'prop') {
        fail(`macro '${step.name}' (${op.source}) takes no arguments`, ctx, step);
      }
      macro = [
        {
          ...only,
          args: mergeArgs(only.args, step.args),
          body: only.body ?? step.body,
        },
      ];
      if (only.body && step.body) fail(`macro '${step.name}' already has a sub-pipeline`, ctx, step);
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
