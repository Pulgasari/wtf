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
const normalizeKey = (v) => v.trim().toLowerCase();
```

the `lsd` import is gone once nothing references it anymore. without the build step
`lsd.fn` works the same at runtime (parse + generate + `new Function`, cached per spec).

## `fn`

tell the compiler to build a helper function. a spec is a whitespace separated pipeline, applied left to right.

| step          | meaning                                                         | example                         |
| ------------- | --------------------------------------------------------------- | ------------------------------- |
| `name`        | vocabulary op, otherwise method call `v.name()`                 | `trim`, `slug`, `unique`        |
| `name(args)`  | same, with args (raw javascript)                                | `split(',')`, `or('n/a')`       |
| `name[spec]`  | same, with a sub-pipeline as callback                           | `map[trim lower]`               |
| `lib::name`   | function from a utility library                                 | `lodash::kebabCase`, `R::take(2)` |
| `.name(args)` | explicit method call, skips the vocabulary                      | `.keys()`, `.map[trim]`         |
| `.a.b`        | property access                                                 | `.user.name`, `.length`         |

`(args)` and `[spec]` combine on every call-like step: `.reduce[.x](0)` -> `v.reduce((v) => v.x, 0)`.
dotted steps may chain without whitespace: `split(',').length`.

```js
lsd.fn("split(',') map[trim lower] compact unique");
// (v) => [...new Set(v.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))]

lsd.fn('filter[.active] sortBy[.name lower] map[.id]');
// sub-pipelines nest as deep as you like

lsd.fn('trim capitalize');
// (v) => { const _0 = v.trim(); return (_0.charAt(0).toUpperCase() + _0.slice(1)); }
```

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
const fn = (v) => {
  const _0 = __lsd_lodash_kebabCase(v.trim());
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

the order decides where the value goes: `lodash::chunk(2)` -> `chunk(v, 2)`, `R::take(2)` -> `take(2, v)`.
a sub-pipeline is passed as the callback: `_::sortBy[.name]` -> `sortBy(v, (v) => v.name)`.

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
// -> kebabCase(sortBy(chunk(v, 2), (v) => v.age))
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

const result = compile(source, { filename, ops, libs, sourcemap: true, onWarn: console.warn });
// -> { code, map, compiled } | null
```

- only static specs (string or template literal without `${}`) get compiled, dynamic ones stay runtime calls and warn.
- spec errors fail the build with `file:line:column` and a caret into the spec.
- args are injected verbatim, the generated function is re-parsed to catch broken args early.

## debugging

```js
lsd.code('trim toLowerCase'); // '(v) => v.trim().toLowerCase()'
```

see [docs/lsd-concepts.md](docs/lsd-concepts.md) for where this could go next.
