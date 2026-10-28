// Schema helpers: short constructors for TypeBox schemas, the bytes leaf, and method declarations.

import Type, {
	type TArray,
	type TBoolean,
	type TInteger,
	type TLiteral,
	type TNull,
	type TNumber,
	type TObject,
	type TOptional,
	type TProperties,
	type TRecord,
	type TSchema,
	type TString,
	type TUnion,
	type TUnknown,
	type TUnsafe,
} from "typebox";

export type { Static, TSchema } from "typebox";

/** Bounds of a string length, a number or an array length. */
export type Bounds = { readonly min?: number; readonly max?: number };

/** A declared default value: a table column with one may be left out of a `put` (slice 6a §5). */
export type Defaulted<T> = { readonly default: T };

/** A string, with optional length bounds, pattern and default. */
export function str(
	options: Bounds & { readonly pattern?: string; readonly default: string },
): TString & Defaulted<string>;
export function str(options?: Bounds & { readonly pattern?: string }): TString;
export function str(options: Bounds & { readonly pattern?: string; readonly default?: string } = {}): TString {
	const pattern = options.pattern === undefined ? {} : { pattern: options.pattern };
	return Type.String({ ...limits(options, "minLength", "maxLength"), ...pattern, ...defaultOf(options) });
}

/** A finite number within optional bounds, with an optional default. */
export function num(options: Bounds & { readonly default: number }): TNumber & Defaulted<number>;
export function num(options?: Bounds): TNumber;
export function num(options: Bounds & { readonly default?: number } = {}): TNumber {
	return Type.Number({ ...limits(options, "minimum", "maximum"), ...defaultOf(options) });
}

/** An integer within optional bounds, with an optional default. */
export function int(options: Bounds & { readonly default: number }): TInteger & Defaulted<number>;
export function int(options?: Bounds): TInteger;
export function int(options: Bounds & { readonly default?: number } = {}): TInteger {
	return Type.Integer({ ...limits(options, "minimum", "maximum"), ...defaultOf(options) });
}

/** A boolean, with an optional default. */
export function bool(options: { readonly default: boolean }): TBoolean & Defaulted<boolean>;
export function bool(options?: Record<never, never>): TBoolean;
export function bool(options: { readonly default?: boolean } = {}): TBoolean {
	return Type.Boolean(defaultOf(options));
}

/** The `default` keyword of `options`, left out when absent (snapshots refuse `undefined`). */
function defaultOf(options: { readonly default?: string | number | boolean }): { default?: string | number | boolean } {
	return options.default === undefined ? {} : { default: options.default };
}

/** `null`; also the omitted side of a method. */
export function nul(): TNull {
	return Type.Null();
}

/** Exactly the given value. */
export function lit<const V extends Literal>(value: V): TLiteral<V> {
	return Type.Literal(value);
}

/** One of the given literals. */
export function oneOf<const V extends Literal[]>(...values: V): TUnion<Literals<V>> {
	// One literal schema per value, in order.
	return Type.Union(values.map((value) => Type.Literal(value))) as TUnion<Literals<V>>;
}

type Literal = string | number | boolean;

type Literals<V extends Literal[]> = V extends [infer First extends Literal, ...infer Rest extends Literal[]]
	? [TLiteral<First>, ...Literals<Rest>]
	: [];

/** Any of the given schemas. */
export function union<const S extends TSchema[]>(schemas: [...S]): TUnion<S> {
	return Type.Union(schemas);
}

/** A closed object: unknown fields are refused. */
export function obj<P extends TProperties>(properties: P): TObject<P> {
	return Type.Object(properties, { additionalProperties: false });
}

/** An array, with optional length bounds. */
export function arr<S extends TSchema>(items: S, options: Bounds = {}): TArray<S> {
	return Type.Array(items, limits(options, "minItems", "maxItems"));
}

/** A string-keyed record. */
export function map<S extends TSchema>(value: S): TRecord<"^.*$", S> {
	return Type.Record(Type.String(), value);
}

/** An optional object field. */
export function opt<S extends TSchema>(schema: S): TOptional<S> {
	return Type.Optional(schema) as TOptional<S>;
}

/** Any value. */
export function unknown(): TUnknown {
	return Type.Unknown();
}

/**
 * A `Uint8Array` leaf, checked by `instanceof` and length, never enumerated. Its enumerable form is the data marker
 * `{ type: "bytes", minLength?, maxLength? }`.
 */
export function bytes(options: Bounds = {}): TUnsafe<Uint8Array> {
	return withBytesCheck({ type: "bytes", ...limits(options, "minLength", "maxLength") });
}

/** The data marker of a bytes schema. */
export type BytesMarker = { readonly type: "bytes"; readonly minLength?: number; readonly maxLength?: number };

/** Attaches the TypeBox check of a bytes marker, non-enumerably so it is never copied as data. */
export function withBytesCheck(marker: BytesMarker): TUnsafe<Uint8Array> {
	const { minLength = 0, maxLength = Number.POSITIVE_INFINITY } = marker;
	const refinement = {
		check: (value: unknown) => value instanceof Uint8Array && value.length >= minLength && value.length <= maxLength,
		error: () => "expected bytes of the declared length",
	};
	Object.defineProperty(marker, "~refine", { value: [refinement] });
	// The marker object is the schema; TypeBox reads the attached check.
	return marker as unknown as TUnsafe<Uint8Array>;
}

/** TypeBox options for the given bounds; an absent bound is left out, since snapshots refuse `undefined`. */
function limits(options: Bounds, min: string, max: string): { [keyword: string]: number } {
	const result: { [keyword: string]: number } = {};
	if (options.min !== undefined) result[min] = options.min;
	if (options.max !== undefined) result[max] = options.max;
	return result;
}

/** A method declaration: its argument and result schemas; an omitted side is `null` on the wire. */
export class Method<A extends TSchema = TSchema, R extends TSchema = TSchema> {
	readonly args: A;
	readonly result: R;

	constructor(args: A, result: R) {
		this.args = args;
		this.result = result;
	}
}

/** A keyed state member's declaration (slice 6a §12): documents of `schema` by string key; only in `local` contracts. */
export class KeyedMember<S extends TSchema = TSchema> {
	readonly schema: S;

	constructor(schema: S) {
		this.schema = schema;
	}
}

/** Declares a keyed state member of a `local` contract: documents of `schema` by string key, each watchable. */
export function keyed<S extends TSchema>(schema: S): KeyedMember<S> {
	return new KeyedMember(schema);
}

/** Declares a method: `method()`, `method(args)`, `method(args, result)` or `method(undefined, result)`. */
export function method(): Method<TNull, TNull>;
export function method<A extends TSchema>(args: A): Method<A, TNull>;
export function method<R extends TSchema>(args: undefined, result: R): Method<TNull, R>;
export function method<A extends TSchema, R extends TSchema>(args: A, result: R): Method<A, R>;
export function method(args?: TSchema, result?: TSchema): Method {
	return new Method(args ?? nul(), result ?? nul());
}
