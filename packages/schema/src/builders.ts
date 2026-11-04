// Schema builders: short functions that return plain JSON Schema objects and carry the static type of the values
// they accept, so `Static<typeof schema>` is the TypeScript type a valid value has. The objects are ordinary data:
// they serialize with JSON.stringify and compile with compile() like any other schema.

import type { TypeBoxStatic } from "./typebox-static.ts";

declare const STATIC: unique symbol;
declare const OPTIONAL_TYPE: unique symbol;

/** A JSON Schema object whose valid values have type `T` (a type-level brand; nothing extra exists at run time). */
export type Schema<T = unknown> = { readonly [keyword: string]: unknown } & { readonly [STATIC]?: T };

// TypeBox is tested first and in its own branch: a builder brand's fallback through TypeBoxStatic would leave
// `Static<S>` of a generic `S` (constrained to builder schemas) unresolvable to its constraint's types.
/**
 * The type of the values `S` accepts: the type a builder recorded; for a TypeBox schema (`'~kind'` or `'~unsafe'`),
 * TypeBox's static type for the common kinds (see `TypeBoxStatic`); else `unknown`.
 */
export type Static<S> = S extends { readonly "~kind": unknown } | { readonly "~unsafe": unknown }
	? TypeBoxStatic<S>
	: S extends { readonly [STATIC]?: infer T }
		? unknown extends T
			? unknown
			: T
		: unknown;

/** Annotations every builder accepts: they describe the schema and never change what it accepts. */
export interface Annotations<T = unknown> {
	readonly title?: string;
	readonly description?: string;
	readonly examples?: readonly T[];
	readonly deprecated?: boolean;
	/** A default value, an annotation for tools and forms; validation never inserts it. */
	readonly default?: T;
}

/** Length bounds of a string, an array or bytes. */
export interface LengthBounds {
	readonly minLength?: number;
	readonly maxLength?: number;
}

/** A string, with optional length bounds (in code points), pattern and format. */
export function str(
	options: Annotations<string> & LengthBounds & { readonly pattern?: string; readonly format?: string } = {},
): Schema<string> {
	return { type: "string", ...options };
}

/** Bounds of a number. */
export interface NumberBounds {
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly multipleOf?: number;
}

/** A number within optional bounds. */
export function num(options: Annotations<number> & NumberBounds = {}): Schema<number> {
	return { type: "number", ...options };
}

/** An integer within optional bounds. */
export function int(options: Annotations<number> & NumberBounds = {}): Schema<number> {
	return { type: "integer", ...options };
}

/** A boolean. */
export function bool(options: Annotations<boolean> = {}): Schema<boolean> {
	return { type: "boolean", ...options };
}

/** `null`. */
export function nul(options: Annotations<null> = {}): Schema<null> {
	return { type: "null", ...options };
}

/** Any value. */
export function unknown(options: Annotations = {}): Schema<unknown> {
	return { ...options };
}

/** Exactly `value` (a string, number, boolean or null). */
export function lit<const V extends string | number | boolean | null>(
	value: V,
	options: Annotations<V> = {},
): Schema<V> {
	return { const: value, ...options };
}

/** One of the given values. */
export function oneOf<const V extends readonly (string | number | boolean | null)[]>(
	values: V,
	options: Annotations<V[number]> = {},
): Schema<V[number]> {
	return { enum: values, ...options };
}

/**
 * Any of the given schemas. A union of objects tagged by a `lit()` property (`{ kind: lit("text"), ... }`) is checked
 * by the tag: only the branch it selects runs, and its errors are the ones reported.
 */
export function union<const S extends readonly Schema[]>(
	schemas: S,
	options: Annotations<Static<S[number]>> = {},
): Schema<Static<S[number]>> {
	return { anyOf: schemas, ...options };
}

/** `schema` or `null`. */
export function nullable<T>(schema: Schema<T>, options: Annotations<T | null> = {}): Schema<T | null> {
	return { anyOf: [schema, { type: "null" }], ...options };
}

/** An array of `items`, with optional length bounds and unique items. */
export function arr<T>(
	items: Schema<T>,
	options: Annotations<T[]> & {
		readonly minItems?: number;
		readonly maxItems?: number;
		readonly uniqueItems?: boolean;
	} = {},
): Schema<T[]> {
	return { type: "array", items, ...options };
}

/** A fixed-length array whose items match `items` in order. */
export function tuple<const S extends readonly Schema[]>(
	items: S,
	options: Annotations<{ -readonly [K in keyof S]: Static<S[K]> }> = {},
): Schema<{ -readonly [K in keyof S]: Static<S[K]> }> {
	return { type: "array", prefixItems: items, items: false, minItems: items.length, ...options };
}

/** An object with string keys and values of `value` (a record). */
export function map<T>(value: Schema<T>, options: Annotations<Record<string, T>> = {}): Schema<Record<string, T>> {
	return { type: "object", additionalProperties: value, ...options };
}

/** A Uint8Array with optional length bounds (an extension of JSON Schema for values that never pass through JSON). */
export function bytes(options: Annotations<Uint8Array> & LengthBounds = {}): Schema<Uint8Array> {
	return { type: "bytes", ...options };
}

/** An optional property of obj(): `{ name: opt(str()) }` may omit `name` or set it to undefined. */
export class Optional<S extends Schema = Schema> {
	declare readonly [OPTIONAL_TYPE]?: S;
	readonly schema: S;

	constructor(schema: S) {
		this.schema = schema;
	}
}

/** Marks an obj() property as optional. */
export function opt<S extends Schema>(schema: S): Optional<S> {
	return new Optional(schema);
}

/** The properties of obj(): a schema or an opt() schema per name. */
export type Properties = { readonly [name: string]: Schema | Optional };

/** The value type of an obj() schema. */
export type StaticObject<P extends Properties> = Simplify<
	{ -readonly [K in keyof P as P[K] extends Optional ? never : K]: Static<P[K]> } & {
		-readonly [K in keyof P as P[K] extends Optional ? K : never]?: P[K] extends Optional<infer S>
			? Static<S>
			: never;
	}
>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * A closed object: the given properties (required unless opt()) and no others. `open: true` allows other
 * properties, as tool schemas from other systems often do.
 */
export function obj<const P extends Properties>(
	properties: P,
	options: Annotations<StaticObject<P>> & { readonly open?: boolean } = {},
): Schema<StaticObject<P>> {
	const { open, ...annotations } = options;
	const props: Record<string, Schema> = {};
	const required: string[] = [];
	for (const [name, property] of Object.entries(properties)) {
		if (property instanceof Optional) props[name] = property.schema;
		else {
			props[name] = property;
			required.push(name);
		}
	}
	return {
		type: "object",
		properties: props,
		...(required.length > 0 ? { required } : {}),
		...(open === true ? {} : { additionalProperties: false }),
		...annotations,
	};
}
