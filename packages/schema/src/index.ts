// JSON Schema validation (drafts 2020-12 and 7) without eval: compile() builds a schema into plain closures once.
// The builders return plain JSON Schema objects typed with the values they accept.

export {
	type Annotations,
	arr,
	type BigintBounds,
	bigint,
	bool,
	bytes,
	int,
	type LengthBounds,
	lit,
	map,
	type NumberBounds,
	nul,
	nullable,
	num,
	Optional,
	obj,
	oneOf,
	opt,
	type Properties,
	recursive,
	type Schema,
	type Static,
	type StaticObject,
	str,
	tuple,
	union,
	unknown,
	unsafe,
} from "./builders.ts";
export { deepEqual as equal } from "./checks.ts";
export type { Check, CompileOptions, FormatCheck, JsonSchema, ParseResult, ValidationError } from "./types.ts";
export { CoercingValidator, compile, Validator } from "./validator.ts";
