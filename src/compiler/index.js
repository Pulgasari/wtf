// build-time compiler: replaces lsd factory calls with static specs by the generated functions
// and drops the `lsd` import once nothing references it anymore.

import { parse as parseJs, parseExpressionAt } from 'acorn';
import { ancestor } from 'acorn-walk';
import MagicString from 'magic-string';
import { joinTemplate } from '../lsd/parse.js';
import { generateKind } from '../lsd/generate/index.js';
import { createVocabularies } from '../lsd/ops.js';
import { guess } from '../lsd/guess.js';
import { createAdapters } from '../lsd/libs.js';
import { LsdCompileError } from './errors.js';
import {
  NOT_STATIC,
  countIdentifiers,
  matchChain,
  matchFactory,
  matchGuess,
  parentOf,
  staticSpec,
  staticValue,
  wrapArrow,
} from './ast.js';
import { createLibImports, findLsdImports, importedLocals, removeUnusedImports } from './imports.js';

export { LsdCompileError } from './errors.js';
export { loadLibExports } from './exports.js';

const ACORN = { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true };

/**
 * @returns {{ code: string, map: object | null, compiled: number } | null}
 *   null if the source does not import `lsd` from `module` or nothing could be compiled.
 */
export function compile(source, options = {}) {
  const {
    filename,
    ops,
    predicates,
    libs,
    prefer = [],
    libExports = {},
    module = 'wtf.js',
    sourcemap = true,
    onWarn = () => {},
  } = options;

  if (!source.includes(module)) return null;

  const ast = parseJs(source, ACORN);
  const imports = findLsdImports(ast, module);
  if (!imports.length) return null;

  const counts = countIdentifiers(ast);
  const locals = new Set(imports.map((entry) => entry.local));
  const taken = new Set([...counts.keys(), ...importedLocals(ast)]);
  const libImports = createLibImports(createAdapters(libs), taken, { prefer, libExports });
  const generateOptions = {
    ...createVocabularies(ops, predicates),
    lib: libImports.resolve,
    implicit: libImports.implicit,
  };
  const out = new MagicString(source);
  let compiled = 0;

  // errors from the generator get the location of the call
  const at = (node, task) => {
    try {
      return task();
    } catch (error) {
      if (error instanceof LsdCompileError) throw error;
      throw new LsdCompileError(error.message, { filename, loc: node.loc.start, cause: error });
    }
  };

  const build = (node, kind, spec, captures = 0) =>
    at(node, () => validate(generateKind(kind, spec, { ...generateOptions, captures })));

  const count = (local) => {
    imports.find((entry) => entry.local === local).replaced++;
    compiled++;
  };

  const replace = (node, ancestors, local, code) => {
    out.overwrite(node.start, node.end, wrapArrow(code, node, parentOf(ancestors)));
    count(local);
  };

  const warnDynamic = (node, call) =>
    onWarn(`${filename ?? '<input>'}:${node.loc.start.line}: ${call} with dynamic input stays a runtime call`);

  // single steps for lsd.guess, evaluated at build time
  const buildStep = (spec) => new Function('$libs', `return ${generateKind('fn', spec, generateOptions)}`)({});

  // lsd.guess({ ' A ': 'a' }) -> search at build time, inline the found pipeline with a comment
  const compileGuess = (node, ancestors, local) => {
    const [examples, guessOptions = {}] = node.arguments.map(staticValue);
    if (examples === NOT_STATIC || guessOptions === NOT_STATIC || node.arguments.length > 2) {
      warnDynamic(node, `${local}.guess()`);
      return;
    }
    const spec = at(node, () => guess(examples, buildStep, guessOptions));
    if (spec === null) {
      throw new LsdCompileError('lsd.guess: no pipeline found for these examples', { filename, loc: node.loc.start });
    }
    replace(node, ancestors, local, `/* lsd: ${spec.replaceAll('*/', '* /')} */ ${build(node, 'fn', spec)}`);
  };

  ancestor(ast, {
    // lsd.fn`spec ${value}` -> (($0) => fn)(value), captures are evaluated once, like at runtime
    TaggedTemplateExpression(node, _state, ancestors) {
      const match = matchFactory(node.tag, locals);
      if (!match) return;

      const { quasis, expressions } = node.quasi;
      const raw = quasis.map((quasi) => quasi.value.raw);
      const fnCode = build(node, match.kind, joinTemplate(raw, match.kind), expressions.length);

      if (!expressions.length) {
        replace(node, ancestors, match.local, fnCode);
        return;
      }
      // keep the interpolated expressions in place, they may contain compiled calls themselves
      const names = expressions.map((_, index) => `$${index}`).join(', ');
      out.overwrite(node.start, expressions[0].start, `((${names}) => ${fnCode})(`);
      expressions.slice(1).forEach((expression, index) => out.overwrite(expressions[index].end, expression.start, ', '));
      out.overwrite(expressions.at(-1).end, node.end, ')');
      count(match.local);
    },

    CallExpression(node, _state, ancestors) {
      const guessLocal = matchGuess(node.callee, locals);
      if (guessLocal) {
        compileGuess(node, ancestors, guessLocal);
        return;
      }

      const match = matchFactory(node.callee, locals);
      if (!match) return;
      const spec = staticSpec(node.arguments);
      if (spec === null) {
        warnDynamic(node, `${match.local}.${match.kind}()`);
        return;
      }
      replace(node, ancestors, match.local, build(node, match.kind, spec));
    },

    // lsd.$.trim.lower -> fn('trim lower'), only the outermost member of a chain
    MemberExpression(node, _state, ancestors) {
      const parent = parentOf(ancestors);
      if (parent?.type === 'MemberExpression' && parent.object === node && !parent.computed) return;
      const chain = matchChain(node, locals);
      if (chain) replace(node, ancestors, chain.local, build(node, 'fn', chain.steps.join(' ')));
    },
  });

  if (!compiled) return null;

  removeUnusedImports(imports, counts, out);
  if (libImports.size) {
    // after a hashbang line, otherwise at the very top
    const after = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
    if (after > 0) out.appendLeft(after, libImports.code());
    else out.prepend(libImports.code());
  }

  return {
    code: out.toString(),
    map: sourcemap ? out.generateMap({ source: filename, includeContent: true, hires: true }) : null,
    compiled,
  };
}

// args are injected verbatim, so make sure the result is still valid javascript
function validate(fnCode) {
  try {
    const node = parseExpressionAt(fnCode, 0, { ecmaVersion: 'latest' });
    if (node.end !== fnCode.length) throw new Error(`unexpected input at ${node.end}`);
  } catch (error) {
    throw new Error(`generated invalid code (check the args in your spec): ${fnCode}\n  ${error.message}`);
  }
  return fnCode;
}
