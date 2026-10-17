// ast helpers for the compiler: matching lsd calls, reading static values, placing arrows.

import { full } from 'acorn-walk';
import { KINDS } from '../lsd/generate/index.js';

// parents in which an arrow function can stand without parens
const BARE_ARROW_OK = {
  VariableDeclarator: (parent, node) => parent.init === node,
  AssignmentExpression: (parent, node) => parent.right === node,
  AssignmentPattern: (parent, node) => parent.right === node,
  Property: (parent, node) => parent.value === node,
  PropertyDefinition: (parent, node) => parent.value === node,
  CallExpression: (parent, node) => parent.callee !== node,
  NewExpression: (parent, node) => parent.callee !== node,
  ArrayExpression: () => true,
  ReturnStatement: () => true,
  ExportDefaultDeclaration: () => true,
  ArrowFunctionExpression: (parent, node) => parent.body === node,
  ConditionalExpression: (parent, node) => parent.test !== node,
  ExpressionStatement: () => true,
  TemplateLiteral: () => true,
};

export const parentOf = (ancestors) => ancestors[ancestors.length - 2];

// parens around the arrow only where its position needs them
export function wrapArrow(fnCode, node, parent) {
  return BARE_ARROW_OK[parent?.type]?.(parent, node) ? fnCode : `(${fnCode})`;
}

// `<local>.<name>` with a plain property -> { local, name }
function lsdMember(node, locals) {
  if (node.type !== 'MemberExpression' || node.computed || node.optional) return null;
  if (node.object.type !== 'Identifier' || !locals.has(node.object.name)) return null;
  return { local: node.object.name, name: node.property.name };
}

// `lsd.fn`, `lsd.is`, ... -> { local, kind }
export function matchFactory(node, locals) {
  const member = lsdMember(node, locals);
  return member && KINDS.includes(member.name) ? { local: member.local, kind: member.name } : null;
}

// `lsd.guess` -> local
export function matchGuess(node, locals) {
  const member = lsdMember(node, locals);
  return member?.name === 'guess' ? member.local : null;
}

// `lsd.$.a.b.c` -> { local, steps: ['a', 'b', 'c'] }
export function matchChain(node, locals) {
  const steps = [];
  let current = node;
  while (current.type === 'MemberExpression' && !current.computed && !current.optional) {
    steps.unshift(current.property.name);
    current = current.object;
  }
  if (current.type !== 'Identifier' || !locals.has(current.name) || steps[0] !== '$') return null;
  return { local: current.name, steps: steps.slice(1) };
}

// string literal or template literal without expressions as the only argument, otherwise null
export function staticSpec(args) {
  if (args.length !== 1) return null;
  const value = staticValue(args[0]);
  return typeof value === 'string' ? value : null;
}

export const NOT_STATIC = Symbol('not static');

// evaluates literal-only expressions (objects, arrays, strings, numbers, booleans, null, negation)
export function staticValue(node) {
  switch (node.type) {
    case 'Literal':
      return node.regex ? NOT_STATIC : node.value;
    case 'TemplateLiteral':
      return node.expressions.length ? NOT_STATIC : node.quasis[0].value.cooked;
    case 'UnaryExpression': {
      if (node.operator !== '-' && node.operator !== '!') return NOT_STATIC;
      const value = staticValue(node.argument);
      if (value === NOT_STATIC) return value;
      return node.operator === '-' ? -value : !value;
    }
    case 'ArrayExpression': {
      const items = node.elements.map((element) => (element && element.type !== 'SpreadElement' ? staticValue(element) : NOT_STATIC));
      return items.includes(NOT_STATIC) ? NOT_STATIC : items;
    }
    case 'ObjectExpression': {
      const result = {};
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init') return NOT_STATIC;
        const value = staticValue(property.value);
        if (value === NOT_STATIC) return NOT_STATIC;
        result[property.key.type === 'Identifier' ? property.key.name : property.key.value] = value;
      }
      return result;
    }
    default:
      return NOT_STATIC;
  }
}

// identifier name -> number of references, in one walk. import specifiers are not visited by acorn-walk.
export function countIdentifiers(ast) {
  const counts = new Map();
  full(ast, (node) => {
    if (node.type === 'Identifier') counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  });
  return counts;
}
