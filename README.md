# WTF.js

```js
// moin und guten tag!
const greeting = 'moin und guten tag!';
const greeting = wtf.str('moin und guten tag!');
const greeting = wtf.str[' ']('moin', 'und', 'guten', 'tag!');

// bird, cat, dog
const list = wtf.str[', ']('bird', 'cat', 'dog');
```

---

# LSD | lazy stupid dev

stop hand-writing tiny helpers. describe them, let the compiler write them.

```js
import { lsd } from 'wtf.js';

const normalizeKey = lsd.fn('trim toLowerCase');
```

after the build:

```js
const normalizeKey = (it) => it.trim().toLowerCase();
```

the `lsd` import is gone once nothing references it anymore. without the build step
`lsd.fn` works the same at runtime (parse + generate + `new Function`, cached per spec).

## `fn`

tell the compiler to build a helper function. a spec is a whitespace separated pipeline, applied left to right.

| step          | meaning                                                         | example                         |
| ------------- | --------------------------------------------------------------- | ------------------------------- |
| `name`        | vocabulary op, otherwise method call `it.name()`                 | `trim`, `slug`, `unique`        |
| `name(args)`  | same, with args (raw javascript)                                | `split(',')`, `or('n/a')`       |
| `name[spec]`  | same, with a sub-pipeline as callback                           | `map[trim lower]`               |
| `lib::name`   | function from a utility library                                 | `lodash::kebabCase`, `R::take(2)` |
| `.name(args)` | explicit method call, skips the vocabulary                      | `.keys()`, `.map[trim]`         |
| `.a.b`        | property access                                                 | `.user.name`, `.length`         |
| `(expr)`      | raw javascript, `it` is the current value                       | `(it + 'px')`, `(it * 2)`       |
| `a b =>`      | param list at the start of a pipeline                           | `reduce[acc it => (acc + it)](0)` |
| `${value}`    | captured value in a tagged template                             | ``lsd.fn`or(${fallback})` ``    |

`(args)` and `[spec]` combine on every call-like step: `.reduce[.x](0)` -> `it.reduce((it) => it.x, 0)`.
dotted steps may chain without whitespace: `split(',').length`.

```js
lsd.fn("split(',') map[trim lower] compact unique");
// (it) => [...new Set(it.split(',').map((it) => it.trim().toLowerCase()).filter(Boolean))]

lsd.fn('filter[.active] sortBy[.name lower] map[.id]');
// sub-pipelines nest as deep as you like

lsd.fn('trim capitalize');
// (it) => { const _0 = it.trim(); return (_0.charAt(0).toUpperCase() + _0.slice(1)); }
```

### `it`, expressions and params

every pipeline works on `it`. an `(expr)` step is plain javascript for everything the vocabulary does not cover:

```js
lsd.fn("num (it + 'px')");
// (it) => { it = Number(it); return (it + 'px'); }
```

a pipeline may declare its params. it runs on `it` if that is one of them, otherwise on the first one.
this works for callbacks as well as for `fn` itself:

```js
lsd.fn('reduce[acc it => (acc + it.price)](0)');
// (it) => it.reduce((acc, it) => (acc + it.price), 0)

lsd.fn('a b => (a + b)');
// (a, b) => (a + b)
```

### outer values: tagged templates

plain string specs cannot see variables of the surrounding scope at runtime. tagged templates can,
in both modes with the same semantics: interpolations are evaluated once, when `lsd.fn` runs.

```js
const greet = lsd.fn`or(${fallback}) trim ${exclaim}`;
// build: (($0, $1) => (it) => $1((it ?? $0).trim()))(fallback, exclaim)
```

- an interpolation inside args is a value, standing alone as a step it is a function called with `it`.
- tagged templates use the raw strings, so regex escapes need no doubling: ``lsd.fn`replace(/\s+/g, '-')` ``.

### vocabulary

native one-liners, no dependencies:

| group    | ops                                                       |
| -------- | --------------------------------------------------------- |
| strings  | `lower` `upper` `capitalize` `words` `slug` `reverse`     |
| coercion | `str` `num` `int` `float` `bool` `not`                    |
| arrays   | `compact` `unique` `first` `last` `sum` `reverse` `sortBy[key]` `groupBy[key]` |
| objects  | `keys` `values` `entries` `json` `parseJson`              |
| misc     | `or(fallback)` `log`                                      |

array ops never mutate their input (`reverse` -> `toReversed`, `sortBy` -> `toSorted`).

## libraries

lsd does not want to own a hundred helpers. lodash and friends already wrote them.

```js
lsd.fn('trim lodash::kebabCase reverse');
```

after the build:

```js
import { kebabCase as __lsd_lodash_kebabCase } from 'lodash-es';
const fn = (it) => {
  const _0 = __lsd_lodash_kebabCase(it.trim());
  return (typeof _0 === 'string' ? [..._0].reverse().join('') : _0.toReversed());
};
```

the compiler adds the imports itself (one declaration per module, tree-shakeable named imports).

| prefix              | module        | order      |
| ------------------- | ------------- | ---------- |
| `lodash::` / `_::`  | `lodash-es`   | data-first |
| `underscore::`      | `underscore`  | data-first |
| `ramda::` / `R::`   | `ramda`       | data-last  |
| `esToolkit::`       | `es-toolkit`  | data-first |
| `remeda::`          | `remeda`      | data-first |

the order decides where the value goes: `lodash::chunk(2)` -> `chunk(it, 2)`, `R::take(2)` -> `take(2, it)`.
a sub-pipeline is passed as the callback: `_::sortBy[.name]` -> `sortBy(it, (it) => it.name)`.

configure or add libraries:

```js
lsd({
  libs: {
    lodash: { module: (name) => `lodash/${name}.js`, named: false }, // per-function modules
    mine: { module: '~/utils', order: 'data-last' },
    M: 'mine', // alias
  },
});
```

### prefer: library functions without prefix

```js
lsd({ prefer: ['lodash'] });   // build
lsd.prefer('lodash');          // runtime

lsd.fn('camelCase chunk(2)');
// chunk(camelCase(it), 2)
```

names outside the vocabulary are looked up in the exports of the preferred libraries (in order) before they
fall back to a method call. note that this also catches names like `trim` or `map`, which lodash exports too;
`.trim()` always forces the method. the vite plugin loads the exports itself, with `compile` pass them in:

```js
import { compile, loadLibExports } from 'wtf.js/compiler';

const libExports = await loadLibExports(['lodash'], { root });
compile(source, { prefer: ['lodash'], libExports });
```

known exports also catch typos: `lodash::kebabcase` -> `'kebabcase' is not exported by 'lodash', did you mean 'kebabCase'?`

### runtime registration

at runtime (without build) register the library objects:

```js
import * as _ from 'lodash-es';
lsd.use('lodash', _);
lsd.use('mine', mine, { order: 'data-last' });
```

### presets: lsd names, library code

ops can be macros, i.e. spec strings. a preset maps lsd's vocabulary onto a library:

```js
import lodash from 'wtf.js/presets/lodash';

// build
lsd({ ops: lodash });
// runtime
lsd.use('lodash', _);
lsd.define(lodash);

lsd.fn('chunk(2) sortBy[.age] kebab');
// -> kebabCase(sortBy(chunk(it, 2), (it) => it.age))
```

single-step macros forward args and sub-pipelines (`chunk(2)` -> `lodash::chunk(2)`).
the preset covers strings (`camel` `kebab` `snake` `title` `deburr` ...), arrays (`chunk` `uniqueBy` `groupBy`
`countBy` `keyBy` `partition` ...), math (`sumBy` `mean` `maxBy` ...) and objects (`pick` `omit` `get` `clone` ...),
see [src/lsd/presets/lodash.js](src/lsd/presets/lodash.js).

## custom ops

an op is either a macro (spec string) or a code generator: it gets the input expression as source and
returns the output expression.

```js
// lsd.ops.js
export default {
  clean: 'trim lower',
  shout: (x) => `${x}.toUpperCase() + '!'`,
  pad: { emit: (x, args) => `String(${x}).padStart(${args})`, args: 'required' },
  pluck: { emit: (x, args, { body }) => `${x}.map(${body})`, body: 'required' },
};
```

```js
// vite.config.js
import lsd from 'wtf.js/vite';
import ops from './lsd.ops.js';

export default { plugins: [lsd({ ops })] };

// runtime fallback (dev / unbuilt), keep both in sync
import { lsd } from 'wtf.js';
lsd.define(ops);
```

- `ref: true` marks ops that use their input more than once, the generator then binds a temp const.
- `bind(code)` (third emit argument) hoists code into a temp const, e.g. a key function used twice.
- `args` / `body`: `'none' | 'optional' | 'required'`.

## compiler

```js
import { compile } from 'wtf.js/compiler';

const result = compile(source, { filename, ops, libs, prefer, libExports, sourcemap: true, onWarn: console.warn });
// -> { code, map, compiled } | null
```

- static specs (string literals, template literals, tagged templates) get compiled, dynamic ones stay runtime calls and warn.
- spec errors fail the build with `file:line:column` and a caret into the spec.
- args are injected verbatim, the generated function is re-parsed to catch broken args early.

## debugging

```js
lsd.code('trim toLowerCase'); // '(it) => it.trim().toLowerCase()'
```

see [docs/lsd-concepts.md](docs/lsd-concepts.md) for where this could go next.
