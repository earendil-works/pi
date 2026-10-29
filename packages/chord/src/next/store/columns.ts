// Table columns (decisions "Flat columns", "Nullable columns and the `set` form", "Restricted names"): the restricted
// subset of L1's helpers a table's `columns` take (`str int num bool`, `opt(...)` of them, `json(...)`, defaults),
// their types for rows, keys and column references, and the column descriptors and records the store keeps.

import type { TBoolean, TInteger, TNumber, TOptional, TString } from "typebox";
import type { Static, TSchema } from "../contracts/index.ts";
import { JsonColumn, type JsonColumnSchema } from "./json-column.ts";
import { storedText } from "./text.ts";

/** A schema a table column takes. */
export type ColumnSchema =
	| ScalarSchema
	| JsonColumnSchema<unknown>
	| TOptional<ScalarSchema | JsonColumnSchema<unknown>>;

type ScalarSchema = TString | TInteger | TNumber | TBoolean;

/** A table's `columns`: a flat record of column schemas. */
export type Columns = { readonly [name: string]: ColumnSchema };

/** A column's type in the store. */
export type ColumnType = "str" | "int" | "num" | "bool" | "json";

/** The store type of column schema `S`. */
export type ColumnTypeOf<S> = S extends TOptional<infer I>
	? ColumnTypeOf<I>
	: S extends TString
		? "str"
		: S extends TInteger
			? "int"
			: S extends TNumber
				? "num"
				: S extends TBoolean
					? "bool"
					: "json";

/** The value type of column schema `S` (without `undefined` for an `opt(...)` one). */
export type ValueOf<S> = S extends TOptional<infer I> ? ValueOf<I> : S extends TSchema ? Static<S> : never;

/** The names of the columns that are not `opt(...)`. */
type RequiredNames<C extends Columns> = { [K in keyof C]: C[K] extends TOptional<TSchema> ? never : K }[keyof C];

/** The names of the columns with a declared default. */
type DefaultedNames<C extends Columns> = {
	[K in keyof C]: C[K] extends { readonly default: unknown } ? K : never;
}[keyof C];

/** A row as reads return it: every non-`opt` column, the `opt(...)` ones when not `NULL`. */
export type RowOf<C extends Columns> = { [K in RequiredNames<C>]: ValueOf<C[K]> } & {
	[K in Exclude<keyof C, RequiredNames<C>>]?: ValueOf<C[K]>;
};

/** A row as `put` takes it: as read, the columns with a default may be left out (rule 15). */
export type PutRowOf<C extends Columns> = { [K in Exclude<RequiredNames<C>, DefaultedNames<C>>]: ValueOf<C[K]> } & {
	[K in Exclude<keyof C, Exclude<RequiredNames<C>, DefaultedNames<C>>>]?: ValueOf<C[K]>;
};

/** The columns a key, an index or an `orderBy` may use: non-`opt` `str` or `int`. */
export type OrderColumn<C extends Columns> = {
	[K in keyof C]: C[K] extends TString | TInteger ? (C[K] extends TOptional<TSchema> ? never : K) : never;
}[keyof C] &
	string;

/** A column of the store: its name, type, nullability and default; a `json(...)` one with its definition. */
export type Column =
	| {
			readonly name: string;
			readonly type: "str" | "int" | "num" | "bool";
			readonly optional: boolean;
			readonly default: string | number | boolean | undefined;
	  }
	| { readonly name: string; readonly type: "json"; readonly optional: boolean; readonly json: JsonColumn };

/** A column as the `table` write records it (slice 6a §5): what a replica needs without the plugin's code. */
export type ColumnRecord = {
	readonly type: ColumnType;
	readonly optional?: true;
	readonly default?: string | number | boolean;
	/** A `json(...)` column's version and schema fingerprint. */
	readonly version?: number;
	readonly fingerprint?: string;
};

/** The column name rule (decision "Restricted names"). */
export const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The columns of `columns` in declaration order, checked (declaration policy: JavaScript callers reach it): names
 * `[A-Za-z_][A-Za-z0-9_]*` without two equal ignoring ASCII case, only the helpers' types, no bounds or patterns (a
 * bulk `set` could not keep them), a default of the column's type and not on an `opt(...)` column.
 */
export function describeColumns(columns: Columns, table: string): Column[] {
	const seen = new Set<string>();
	return Object.entries(columns).map(([name, schema]) => {
		checkColumnName(name, table);
		const folded = name.toLowerCase();
		if (seen.has(folded)) throw new Error(`${table}: column "${name}" differs from another only in case`);
		seen.add(folded);
		return describeColumn(name, schema, `${table}: column "${name}"`);
	});
}

/** Throws unless `name` follows the column name rule (declaration policy); `what` names the table or the edit. */
export function checkColumnName(name: string, what: string): void {
	if (!COLUMN_NAME.test(name)) throw new Error(`${what}: column "${name}": expected [A-Za-z_][A-Za-z0-9_]*`);
}

const SCALAR_TYPES: { readonly [type: string]: "str" | "int" | "num" | "bool" } = {
	string: "str",
	integer: "int",
	number: "num",
	boolean: "bool",
};

function describeColumn(name: string, schema: ColumnSchema, what: string): Column {
	const optional = Object.hasOwn(schema, "~optional");
	// Declaration policy: a JavaScript caller may pass any schema, so its fields are read as unknown data.
	const fields = schema as unknown as { readonly [key: string]: unknown };
	const json = fields.json;
	if (json instanceof JsonColumn) return { name, type: "json", optional, json };
	const type = SCALAR_TYPES[String(fields.type)];
	if (type === undefined) throw new Error(`${what}: expected str(), int(), num(), bool(), opt(...) or json(...)`);
	for (const key of Object.keys(schema)) {
		if (key !== "type" && key !== "default") throw new Error(`${what}: "${key}" is not supported in a table column`);
	}
	const value = fields.default;
	if (value !== undefined) {
		if (optional) throw new Error(`${what}: an opt(...) column has no default`);
		checkDefault(type, value, what);
	}
	return { name, type, optional, default: value as string | number | boolean | undefined };
}

function checkDefault(type: "str" | "int" | "num" | "bool", value: unknown, what: string): void {
	const valid =
		type === "str"
			? typeof value === "string" && storedText(value, what) === value
			: type === "int"
				? Number.isSafeInteger(value)
				: type === "num"
					? typeof value === "number" && Number.isFinite(value)
					: typeof value === "boolean";
	if (!valid) throw new Error(`${what}: the default ${JSON.stringify(value)} is not a ${type} value`);
}

/** The record of `column` in the `table` write. */
export function columnRecord(column: Column): ColumnRecord {
	const optional = column.optional ? { optional: true as const } : {};
	if (column.type === "json") {
		return { type: "json", ...optional, version: column.json.version, fingerprint: column.json.fingerprint };
	}
	return { type: column.type, ...optional, ...(column.default === undefined ? {} : { default: column.default }) };
}
