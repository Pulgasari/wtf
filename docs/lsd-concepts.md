# LSD: where this could go

the foundation is deliberately small: `spec -> steps -> expression source`, one generator shared by
compiler and runtime. everything below builds on that pipeline without changing its core.

## 1. sub-pipelines (the biggest lever)

today args are raw javascript, so `.map((s) => s.trim())` still means writing the lambda yourself.
let ops declare that their args are a spec instead of code:

```js
lsd.fn('split(",") map[trim lower] compact unique');
lsd.fn('filter[.active] sortBy[.name lower] map[.id]');
```

`[...]` is parsed recursively and generated as a nested arrow. this turns the flat pipe into a small
combinator language and covers most of the "map, filter, sort, pick" helpers people write daily.

## 2. shape builders

pipelines map one value to one value. a lot of glue code builds objects:

```js
lsd.fn('{ id: .id int, name: .name trim, tags: .tags compact unique }');
lsd.fn('pick(id name email)');
lsd.fn('omit(password)');
```

the generator already produces expressions, an object literal of sub-pipelines fits in naturally.

## 3. more factories than `fn`

same compiler, different output shape:

| factory    | example                         | output                                  |
| ---------- | ------------------------------- | --------------------------------------- |
| `lsd.is`   | `lsd.is('string nonEmpty')`     | predicate `(v) => boolean`              |
| `lsd.cmp`  | `lsd.cmp('.age desc, .name')`   | comparator for `sort`                   |
| `lsd.key`  | `lsd.key('.user.id str')`       | key extractor for `groupBy` / `Map`     |

## 4. null safety as a mode

`lsd.fn('?.user.name trim or("anon")')` or a `safe` flag that switches every step to optional chaining.
cheap to implement in the generator, removes a whole class of tiny defensive helpers.

## 5. captured values

args are injected verbatim, so in compiled code `or(fallback)` closes over the outer `fallback`,
while the runtime path (`new Function`) cannot see it. two clean options:

- forbid free identifiers in args (compiler checks the args ast, runtime throws the same error).
- tagged templates: ``lsd.fn`or(${fallback}) trim` `` -> captured values become real parameters,
  identical in both paths.

the tagged template version is nicer and keeps parity.

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

1. sub-pipelines `[...]` (unlocks most real use cases)
2. tagged templates for captures (fixes the only semantic gap between runtime and build)
3. `lsd.is` / `lsd.cmp`
4. shared config + strict mode
5. hoisting / virtual module
6. types
7. natural language + lockfile
