# Changelog

## [Unreleased]

## [1.5.2] - 2026-11-10

## [1.5.1] - 2026-11-09

### Added

- `unsafe<T>(schema)` types a schema as accepting `T` without checking it, as TypeBox's `Type.Unsafe` does.
- `recursive<T>(id, build)` builds a schema that contains itself (a tree), with its type given as `T`.
- `Validator.validate(value)` returns `{ ok: true, value }` or `{ ok: false, errors }` without coercing, on every validator.
- `Static` types TypeBox's `Enum`, `Tuple`, `BigInt` and `Undefined` schemas.
- TypeBox's JavaScript types validate and coerce as TypeBox does: `{ type: "bigint" }` (`Type.BigInt`) and `{ type: "undefined" }` (`Type.Undefined`), with `Value.Convert`'s rules for both; the number keywords apply to numbers and bigints alike, with bounds of either kind. The `bigint()` builder builds the former.
- `equal(a, b)`: JSON equality as `const`, `enum` and `uniqueItems` compare, a drop-in for TypeBox's `Value.Equal`.

### Changed

- Faster checks, still without eval: object and array loops run `const`, small `enum`s, type lists, number bounds, string lengths and patterns inline instead of calling a closure; a closed object looks up keys in declared order first; `anyOf` branches that are bare types (as `nullable` builds) run as one type test. Checks take about 16% less time across the benchmark's speed cases, up to 30% less for tagged unions and 45% less for nullable properties.

### Fixed

- A `number` or `integer` no longer accepts `NaN`, `Infinity` or `-Infinity`, as in TypeBox; before, an unbounded `num()` accepted them. JSON has neither, so only values built in code are affected. Errors name the value (`expected number, got NaN`).
- The third-party licenses are in `THIRD_PARTY_NOTICES/`, renamed from `LICENSES/`, which Vite's license notices read as the package's license file, failing browser builds that bundle the package.
- A required property set to `undefined` is valid when its schema takes `undefined` (a union with `Type.Undefined()`, `Type.Unknown()`, `Type.Any()`), as in TypeBox; before, it was always missing. An optional one set to `undefined` still counts as absent.
- Fixed local `$ref`s in schemas whose root `$id` is a relative path with a directory, such as `schemas/tool.json`: the `$id` was applied twice, so `compile` threw and `unresolvedRefs: "reject"` rejected valid tool arguments. Relative `$id`s are now also applied once with `unevaluatedProperties`/`unevaluatedItems`, when explaining errors under nested resources, and on the first coercion of a schema with `$dynamicRef` ([#11697](https://github.com/earendil-works/pi/issues/11697))

## [1.5.0] - 2026-11-02

### Added

- Initial release: `compile(schema, options)` validates JSON Schema drafts 2020-12 and 7 without `eval` or `new Function`, compiling a schema once into plain closures. `Validator.check` is the boolean check (a type guard for schemas built with the builders), `Validator.errors` reports each failure with a JSON Pointer path. Format checks are in the optional `@earendil-works/pi-schema/formats` entry point.
- Schema builders (`str`, `num`, `int`, `bool`, `nul`, `unknown`, `lit`, `oneOf`, `obj`, `opt`, `arr`, `tuple`, `map`, `union`, `nullable`, `bytes`) that return plain JSON Schema typed with the values it accepts (`Static<typeof schema>`).
- `compile(schema, { coerce: true })` adds `coerce(value)` and `parse(value)` for loosely typed input such as a model's tool call arguments: optional `null`s dropped, TypeBox 1.3.27's `Value.Convert` rules keyed on JSON Schema keywords (numeric strings, `"true"`, single values to arrays, `const`/`enum` members, union branches), then Ajv-style primitive coercion by `type`. `coerce` copies only the paths it changes and returns the input itself when nothing changes; `parse` coerces, then checks. Validators compiled without the option have neither; the README lists every rule.
- `Static` also types TypeBox-built schemas, from TypeBox 1.x's type shapes and without importing TypeBox: String, Number, Integer, Boolean, Null, Literal, Array, Object (with `Type.Optional` and `Type.Readonly` properties), Union, Record, Unsafe, Unknown and Any give TypeBox's static type; other TypeBox kinds give `unknown`.
- `unresolvedRefs: "reject"` compiles a `$ref` that names nothing as `false` (the error is `unresolved reference <ref>`) instead of throwing, for schemas whose references may dangle.
- `formats` also checks `url` and `json-pointer-uri-fragment`, as TypeBox and ajv-formats do.
- `npm run bench` compares conformance, speed (with and without eval), setup cost, memory and bundle size with ata-validator (generated code and its interpreter), Ajv, Zod (native schemas, and `z.fromJSONSchema` for the test suite), TypeBox, @cfworker/json-schema and omptype.
