import { LsdSyntaxError } from './parse.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;

// turns parsed steps into the source of an arrow function.
// single expression if possible, block body with temp consts if an op needs a ref.
export function generate(steps, { vocabulary, spec = '', param = 'v' } = {}) {
  const lines = [];
  let expr = param;
  let temp = 0;

  for (const step of steps) {
    if (step.type === 'prop') {
      expr += step.path.map((key) => `.${key}`).join('');
      continue;
    }

    if (step.type === 'method') {
      expr += `.${step.name}(${step.args})`;
      continue;
    }

    const op = vocabulary[step.name];

    // not in the vocabulary -> plain method call
    if (!op) {
      expr += `.${step.name}(${step.args ?? ''})`;
      continue;
    }

    if (op.args === 'required' && !step.args) {
      throw new LsdSyntaxError(`op '${step.name}' requires arguments`, spec, step.start);
    }
    if (op.args === 'none' && step.args) {
      throw new LsdSyntaxError(`op '${step.name}' takes no arguments`, spec, step.start);
    }

    if (op.ref && !IDENT.test(expr)) {
      const id = `_${temp++}`;
      lines.push(`const ${id} = ${expr};`);
      expr = id;
    }

    expr = op.emit(expr, step.args);
  }

  if (!lines.length) return `(${param}) => ${expr}`;
  return `(${param}) => { ${lines.join(' ')} return ${expr}; }`;
}
