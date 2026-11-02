// Schema helpers: Chord's short constructors over pi-schema's builders (plain JSON Schema, typed with the values they
// accept), and method and keyed member declarations. The helpers keep the shapes contracts were fingerprinted with:
// literals carry their `type`, `oneOf` is a union of literals, `map` a pattern-property record.

import {
	arr as arrSchema,
	bool as boolSchema,
	bytes as bytesSchema,
	int as intSchema,
	nul as nulSchema,
	num as numSchema,
	Optional,
	obj as objSchema,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
	str as strSchema,
	union as unionSchema,
	unknown as unknownSchema,
} from "@earendil-works/pi-schema";

export { Optional, opt, type Schema, type Static } from "@earendil-works/pi-schema";

/** Bounds of a string length, a number or an array length. */
export type Bounds = { readonly min?: number; readonly max?: number };

/** A declared default value: a table column with one may be left out of a `put` (slice 6a §5). */
export type Defaulted<T> = { readonly default: T };

// Interfaces, not intersections: declarations of apps' exported contracts and tables name them (an intersection with
// `Schema<T>` would print pi-schema's private brand, which declaration files cannot name).

/** A string schema (`str()`), told apart from the other scalars by its `type`. */
export interface StringSchema extends Schema<string> {
	readonly type: "string";
}

/** A number schema (`num()`). */
export interface NumberSchema extends Schema<number> {
	readonly type: "number";
}

/** An integer schema (`int()`). */
export interface IntegerSchema extends Schema<number> {
	readonly type: "integer";
}

/** A boolean schema (`bool()`). */
export interface BooleanSchema extends Schema<boolean> {
	readonly type: "boolean";
}

/** The `null` schema (`nul()`): also the omitted side of a method. */
export interface NullSchema extends Schema<null> {
	readonly type: "null";
}

/** A union of literals (`oneOf(...)`). */
export interface LiteralsSchema<V extends Literal> extends Schema<V> {
	readonly anyOf: readonly Schema<V>[];
}

/** A string, with optional length bounds, pattern and default. */
export function str(
	options: Bounds & { readonly pattern?: string; readonly default: string },
): StringSchema & Defaulted<string>;
export function str(options?: Bounds & { readonly pattern?: string }): StringSchema;
export function str(options: Bounds & { readonly pattern?: string; readonly default?: string } = {}): StringSchema {
	const pattern = options.pattern === undefined ? {} : { pattern: options.pattern };
	return strSchema({
		...limits(options, "minLength", "maxLength"),
		...pattern,
		...defaultOf(options),
	}) as StringSchema;
}

/** A finite number within optional bounds, with an optional default. */
export function num(options: Bounds & { readonly default: number }): NumberSchema & Defaulted<number>;
export function num(options?: Bounds): NumberSchema;
export function num(options: Bounds & { readonly default?: number } = {}): NumberSchema {
	return numSchema({ ...limits(options, "minimum", "maximum"), ...defaultOf(options) }) as NumberSchema;
}

/** An integer within optional bounds, with an optional default. */
export function int(options: Bounds & { readonly default: number }): IntegerSchema & Defaulted<number>;
export function int(options?: Bounds): IntegerSchema;
export function int(options: Bounds & { readonly default?: number } = {}): IntegerSchema {
	return intSchema({ ...limits(options, "minimum", "maximum"), ...defaultOf(options) }) as IntegerSchema;
}

/** A boolean, with an optional default. */
export function bool(options: { readonly default: boolean }): BooleanSchema & Defaulted<boolean>;
export function bool(options?: Record<never, never>): BooleanSchema;
export function bool(options: { readonly default?: boolean } = {}): BooleanSchema {
	return boolSchema(defaultOf(options)) as BooleanSchema;
}

/** The `default` keyword of `options`, left out when absent (snapshots refuse `undefined`). */
function defaultOf<T extends string | number | boolean>(options: { readonly default?: T }): { default?: T } {
	return options.default === undefined ? {} : { default: options.default };
}

/** `null`; also the omitted side of a method. */
export function nul(): NullSchema {
	// The builder's `type: "null"`, typed as such.
	return nulSchema() as NullSchema;
}

/** Exactly the given value, with its JSON type (`{ type: "string", const: "a" }`). */
export function lit<const V extends Literal>(value: V): Schema<V> {
	return { type: typeof value, const: value };
}

/** A value `lit(...)` and `oneOf(...)` take. */
export type Literal = string | number | boolean;

/** One of the given literals: a union of `lit(...)` schemas, in order. */
export function oneOf<const V extends Literal[]>(...values: V): LiteralsSchema<V[number]> {
	return { anyOf: values.map((value) => lit(value)) };
}

/** Any of the given schemas. */
export function union<const S extends readonly Schema[]>(schemas: S): Schema<Static<S[number]>> {
	return unionSchema(schemas);
}

/** A closed object: unknown fields are refused; `opt(...)` marks an optional field. */
export function obj<const P extends Properties>(properties: P): Schema<StaticObject<P>> {
	return objSchema(properties);
}

/** An array, with optional length bounds. */
export function arr<T>(items: Schema<T>, options: Bounds = {}): Schema<T[]> {
	return arrSchema(items, limits(options, "minItems", "maxItems"));
}

/** A string-keyed record: one pattern property matching every key. */
export function map<T>(value: Schema<T>): Schema<Record<string, T>> {
	return { type: "object", patternProperties: { "^.*$": value } };
}

/** Any value. */
export function unknown(): Schema<unknown> {
	return unknownSchema();
}

/**
 * A `Uint8Array` leaf, checked by `instanceof` and length, never enumerated: `{ type: "bytes", minLength?, maxLength? }`
 * (pi-schema's extension of JSON Schema for values that never pass through JSON).
 */
export function bytes(options: Bounds = {}): Schema<Uint8Array> {
	return bytesSchema(limits(options, "minLength", "maxLength"));
}

/** Builder options for the given bounds; an absent bound is left out, since snapshots refuse `undefined`. */
function limits(options: Bounds, min: string, max: string): { [keyword: string]: number } {
	const result: { [keyword: string]: number } = {};
	if (options.min !== undefined) result[min] = options.min;
	if (options.max !== undefined) result[max] = options.max;
	return result;
}

/** Whether a declared object field is `opt(...)`. */
export function isOptional(value: unknown): value is Optional {
	return value instanceof Optional;
}

/** A method declaration: its argument and result schemas; an omitted side is `null` on the wire. */
export class Method<A extends Schema = Schema, R extends Schema = Schema> {
	readonly args: A;
	readonly result: R;

	constructor(args: A, result: R) {
		this.args = args;
		this.result = result;
	}
}

/** A keyed state member's declaration (slice 6a §12): documents of `schema` by string key; only in `local` contracts. */
export class KeyedMember<S extends Schema = Schema> {
	readonly schema: S;

	constructor(schema: S) {
		this.schema = schema;
	}
}

/** Declares a keyed state member of a `local` contract: documents of `schema` by string key, each watchable. */
export function keyed<S extends Schema>(schema: S): KeyedMember<S> {
	return new KeyedMember(schema);
}

/** Declares a method: `method()`, `method(args)`, `method(args, result)` or `method(undefined, result)`. */
export function method(): Method<NullSchema, NullSchema>;
export function method<A extends Schema>(args: A): Method<A, NullSchema>;
export function method<R extends Schema>(args: undefined, result: R): Method<NullSchema, R>;
export function method<A extends Schema, R extends Schema>(args: A, result: R): Method<A, R>;
export function method(args?: Schema, result?: Schema): Method {
	return new Method(args ?? nul(), result ?? nul());
}
