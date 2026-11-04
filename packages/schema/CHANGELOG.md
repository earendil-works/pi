# Changelog

## [Unreleased]

### Fixed

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
