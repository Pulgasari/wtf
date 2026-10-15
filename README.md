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

| step          | meaning                                                   | example                    |
| ------------- | --------------------------------------------------------- | -------------------------- |
| `name`        | vocabulary op, otherwise method call `v.name()`           | `trim`, `slug`, `unique`   |
| `name(args)`  | same, with args (raw javascript)                          | `split(',')`, `or('n/a')`  |
| `.name(args)` | explicit method call, skips the vocabulary                | `.keys()`                  |
| `.a.b`        | property access                                           | `.user.name`, `.length`    |

dotted steps may chain without whitespace: `split(',').length`.

```js
lsd.fn("split(',') .map((s) => s.trim()) compact unique");
// (v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]

lsd.fn('trim capitalize');
// (v) => { const _0 = v.trim(); return (_0.charAt(0).toUpperCase() + _0.slice(1)); }
```

### vocabulary

| group    | ops                                                       |
| -------- | --------------------------------------------------------- |
| strings  | `lower` `upper` `capitalize` `words` `slug`               |
| coercion | `str` `num` `int` `float` `bool` `not`                    |
| arrays   | `compact` `unique` `first` `last` `sum`                   |
| objects  | `keys` `values` `entries` `json` `parseJson`              |
| misc     | `or(fallback)` `log`                                      |

### custom ops

an op is a code generator: it gets the input expression as source and returns the output expression.

```js
// lsd.ops.js
export default {
  shout: (x) => `${x}.toUpperCase() + '!'`,
  pad: { emit: (x, args) => `String(${x}).padStart(${args})`, args: 'required' },
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

`ref: true` marks ops that use their input more than once, the generator then binds a temp const.

### compiler

```js
import { compile } from 'wtf.js/compiler';

const result = compile(source, { filename, ops, sourcemap: true, onWarn: console.warn });
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
