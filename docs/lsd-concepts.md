# LSD: where this could go

the foundation is deliberately small: `spec -> steps -> expression source`, one generator shared by
compiler and runtime. everything below builds on that pipeline without changing its core.

## 1. sub-pipelines (done)

`map[trim lower]`, `sortBy[.name lower]`, `lodash::groupBy[.type]`. a `[spec]` suffix is parsed recursively
and passed as a unary arrow callback. open points:

- ~~callbacks with more than one param~~: `reduce[acc it => (acc + it)](0)`.
- ~~`it` placeholder~~: expression steps `(it + 'px')`.

## 1b. libraries (done)

`lib::name` resolves to a named import (build) or a registered object (runtime). presets map lsd names
onto library functions via macros, so the vocabulary grows without lsd owning the code. next steps:

- ~~implicit lookup~~ (done): `lsd({ prefer: ['lodash'] })` resolves unknown names against the library exports
  (the compiler can import the module at build time and check `name in exports`) before falling back
  to a method call. explicit `lib::` stays available for disambiguation.
- more presets: `es-toolkit` (smaller, modern), `remeda`, `ramda`, date libraries (`date-fns::format('yyyy')`).
- ops that are just helper imports from wtf.js itself, for the few things no library does well.
- ~~export checks at build time with a "did you mean" for typos~~ (done, runtime too).
- `prefer` per name class: only for names that are not common prototype methods, so `trim` stays native.

## 2. shape builders (done)

pipelines map one value to one value. a lot of glue code builds objects:

```js
lsd.fn('{ id: .id int, name: .name trim, tags: .tags compact unique }');
lsd.fn('pick(id name email)');
lsd.fn('omit(password)');
```

the generator already produces expressions, an object literal of sub-pipelines fits in naturally.

## 3. more factories than `fn` (done: is, cmp, match, fmt, $, guess)

same compiler, different output shape:

| factory    | example                         | output                                  |
| ---------- | ------------------------------- | --------------------------------------- |
| `lsd.is`   | `lsd.is('string nonEmpty')`     | predicate `(v) => boolean`              |
| `lsd.cmp`  | `lsd.cmp('.age desc, .name')`   | comparator for `sort`                   |
| `lsd.key`  | `lsd.key('.user.id str')`       | key extractor for `groupBy` / `Map`     |

## 4. null safety as a mode (done: `?` step)

`lsd.fn('?.user.name trim or("anon")')` or a `safe` flag that switches every step to optional chaining.
cheap to implement in the generator, removes a whole class of tiny defensive helpers.

## 5. captured values (done via tagged templates)

``lsd.fn`or(${fallback}) trim` `` captures values as real params, identical in both paths.
left over: plain string specs still close over outer identifiers in compiled code but not at runtime.
the compiler could warn about free identifiers in the generated function (walk the ast, subtract params,
temps, captures and known globals) and suggest the tagged template.

## 6. one vocabulary, one config

the runtime / compiler mismatch for custom ops goes away with an `lsd.config.js` that the plugin loads
and also injects as a virtual module the runtime imports. bonus: the config can set the module name,
strict mode and naming of generated helpers.

## 7. hoisting and dedupe

- per module: identical specs become one hoisted `const __lsd_trim_lower = ...`.
- per project: emit helpers into a virtual module (`virtual:lsd`) and import them by name. tree-shaken,
  shared, and readable in the bundle.
- big ops (`slug`, deep `merge`) should reference a real helper import instead of inlining code.

## 8. strict mode

`lsd({ strict: true })`: any call the compiler cannot resolve fails the build. guarantees that production
never ships the parser or `new Function` (relevant for csp without `unsafe-eval`).

## 9. types

two levels:

- ops declare `in` / `out` types, the compiler checks pipelines (`sum` after `trim` is an error).
- typescript template literal types infer signatures from the spec string:
  `lsd.fn('trim lower')` -> `(v: string) => string`. doable for the vocabulary, method fallbacks need
  a lookup table of common prototype methods.

## 10. the actually lazy level

the wink at full strength: specs in loose language, resolved at build time.

```js
const clean = lsd.fn('remove duplicates, sort by name, ignore case');
```

resolution order: vocabulary -> synonym table -> optional llm resolver. to keep builds deterministic
the resolved code is written to an `lsd.lock.json` (spec -> generated source, reviewed and committed),
the build only ever reads the lockfile. new or changed specs require an explicit `lsd resolve` step.

## suggested order

1. ~~sub-pipelines `[...]`~~, ~~libraries + presets~~
2. ~~tagged templates for captures~~, ~~expression steps and params~~
3. ~~`lsd.is` / `lsd.cmp` / `lsd.match` / `lsd.fmt` / builders / `lsd.$` / `lsd.guess`~~
4. shared config + strict mode
5. hoisting / virtual module
6. types
7. natural language + lockfile

## 11. ideas after the factories

- `lsd.guess` with types: derive candidates from the example types and allow args from the examples
  (`split` with the most common separator in the input).
- `lsd.is` as validator with messages: `lsd.check(spec)` returning the failing path instead of `false`.
- `lsd.parse`: the inverse of `fmt`, `lsd.parse('{name} ({age int})')('bo (30)')` -> `{ name, age }`.
- `lsd.$` with args via call-before-access: `lsd.$.split(',').map.trim` (needs the build step to
  disambiguate calls, at runtime a call is always the final call).
- explain mode: `lsd.explain('trim lower')` -> table of steps and the code each one produced.
