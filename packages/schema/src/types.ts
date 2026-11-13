// Public types: the schema accepted by compile(), its options, and the errors a failed value produces.

/**
 * A JSON Schema: `true`, `false` or a schema object. Schemas come from tool definitions, MCP servers and other
 * untrusted sources, so compile() reads every keyword defensively instead of trusting a static shape.
 */
export type JsonSchema = boolean | object;

/** A format check: whether `value` (a string) has the format. */
export type FormatCheck = (value: string) => boolean;

/** Options of compile(). */
export interface CompileOptions {
	/** The draft whose semantics apply: "2020-12" (default) or "7". */
	readonly draft?: "2020-12" | "7";
	/**
	 * Format name to check. Without it `format` is an annotation, as draft 2020-12 specifies. The standard formats are
	 * in `@earendil-works/pi-schema/formats`.
	 */
	readonly formats?: Readonly<Record<string, FormatCheck>>;
	/** Schema documents by URI, for `$ref`s to other documents. */
	readonly schemas?: Readonly<Record<string, JsonSchema>>;
	/** Add `coerce()` and `parse()` to the validator, for loosely typed input (see the README's Coercion section). */
	readonly coerce?: boolean;
	/**
	 * What a `$ref` that names nothing (a missing definition, a document not in `schemas`) does: `"throw"` (default)
	 * makes compile() throw; `"reject"` compiles it as `false`, so only values at that place fail, with the error
	 * "unresolved reference".
	 */
	readonly unresolvedRefs?: "throw" | "reject";
}

/** The result of `parse()`: the coerced value when it is valid, else the errors of the coerced value. */
export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly errors: ValidationError[] };

/** One failure of a value: where it is (a JSON Pointer, "" for the value itself), the failing keyword and a message. */
export interface ValidationError {
	readonly path: string;
	readonly keyword: string;
	readonly message: string;
}

/** A schema object as compile() reads it: any keyword, of any value, checked where it is used. */
export type SchemaObject = { readonly [keyword: string]: unknown };

/** A compiled boolean check. */
export type Check = (value: unknown) => boolean;
