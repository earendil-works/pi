// Rows (slice 6a §5 "Values at write", §9): one compiled codec per table version between a plugin's rows and keys
// (a trust boundary, checked closed) and what the store binds and reads; `json(...)` cells serialized at staging
// (rule 8), never walked (R9), and migrated on access when read.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { SqliteValue } from "../../sqlite/index.ts";
import { invalid } from "../data/internal.ts";
import type { Column, ColumnType } from "./columns.ts";
import { storedText } from "./text.ts";

/** A scalar cell as the store keeps it in rows, writes and operands: a well-formed string, a number or a boolean. */
export type Scalar = string | number | boolean;

/** A row as the outbox records it: the stored values, `opt(...)` columns absent when `NULL`. */
export type StoredRow = { readonly [column: string]: Scalar | JsonValue };

/** A `put` ready for the step: its parameters in `physical` order and its record. */
export type EncodedRow = {
	readonly params: readonly SqliteValue[];
	readonly row: StoredRow;
	/** Each written `json(...)` column's version. */
	readonly columns: { readonly [column: string]: number };
	/** The row's key identity, as `EncodedKey.id`. */
	readonly id: string;
};

/** A key ready for the store: its parameters in key order, its record and its identity within one table. */
export type EncodedKey = {
	readonly params: readonly SqliteValue[];
	readonly key: { readonly [column: string]: Scalar };
	/** `JSON.stringify` of the parameters: equal keys, equal ids. */
	readonly id: string;
};

/** The physical name of a `json(...)` column's version column, and of the row's eager-step version. */
export function versionColumn(column: string): string {
	return `${column}$v`;
}

/** The row's eager-step version column (W11): set by `put` and eager migration steps only. */
export const ROW_VERSION = "$v";

/** The physical column order of a stored row: the declared columns, each `json(...)` column's version, then `$v`. */
export function physicalColumns(columns: readonly { readonly name: string; readonly type: ColumnType }[]): string[] {
	return [
		...columns.map(({ name }) => name),
		...columns.filter(({ type }) => type === "json").map(({ name }) => versionColumn(name)),
		ROW_VERSION,
	];
}

/** A scalar as SQLite binds it: booleans as 0 and 1. */
export function toSqlite(scalar: Scalar): string | number {
	return scalar === true ? 1 : scalar === false ? 0 : scalar;
}

/**
 * A table version's codec: `put` rows and keys checked and encoded, stored rows decoded. `physical` is the column
 * order of an encoded row (`physicalColumns`).
 */
export class RowCodec {
	readonly physical: readonly string[];
	readonly #columns: readonly Column[];
	readonly #key: readonly Column[];
	readonly #json: readonly Extract<Column, { readonly type: "json" }>[];
	readonly #names: ReadonlySet<string>;
	readonly #keyNames: ReadonlySet<string>;
	/** The positions of the key columns in `physical`. */
	readonly #keyPositions: readonly number[];
	readonly #table: string;

	constructor(columns: readonly Column[], key: readonly string[], table: string) {
		this.#columns = columns;
		this.#key = key.map((name) => columns.find((column) => column.name === name)!);
		this.#json = columns.filter(
			(column): column is Extract<Column, { readonly type: "json" }> => column.type === "json",
		);
		this.#names = new Set(columns.map(({ name }) => name));
		this.#keyNames = new Set(key);
		this.#keyPositions = key.map((name) => columns.findIndex((column) => column.name === name));
		this.#table = table;
		this.physical = physicalColumns(columns);
	}

	/**
	 * Checks and encodes a `put` row of table version `version` (a trust boundary): a plain object with every
	 * non-`opt` column (a defaulted one filled in) and no other field; `invalid/args` otherwise.
	 */
	put(row: unknown, version: number): EncodedRow {
		const what = `${this.#table}: put`;
		const fields = this.#closed(row, this.#names, what);
		const params: SqliteValue[] = [];
		const stored: { [column: string]: Scalar | JsonValue } = {};
		const versions: { [column: string]: number } = {};
		for (const column of this.#columns) {
			let value = fields[column.name];
			if (value === undefined && column.type !== "json") value = column.default;
			if (value === undefined) {
				if (!column.optional) throw invalid("args", `${what}: column "${column.name}" is missing`);
				params.push(null);
				continue;
			}
			const cell = encodeCell(column, value, `${what}: column "${column.name}"`);
			params.push(cell.param);
			stored[column.name] = cell.stored;
		}
		for (const column of this.#json) {
			const present = Object.hasOwn(stored, column.name);
			if (present) versions[column.name] = column.json.version;
			params.push(present ? column.json.version : null);
		}
		params.push(version);
		const id = JSON.stringify(this.#keyPositions.map((position) => params[position]));
		return { params, row: stored, columns: versions, id };
	}

	/** Checks and encodes a key (a trust boundary): an object with exactly the key columns; `invalid/args` otherwise. */
	key(key: unknown, what: string): EncodedKey {
		const fields = this.#closed(key, this.#keyNames, `${this.#table}: ${what}: the key`);
		const params: SqliteValue[] = [];
		const stored: { [column: string]: Scalar } = {};
		for (const column of this.#key) {
			const value = fields[column.name];
			const where = `${this.#table}: ${what}: key column "${column.name}"`;
			if (value === undefined) throw invalid("args", `${where} is missing`);
			const cell = encodeScalar(column, value, where);
			params.push(cell);
			stored[column.name] = cell;
		}
		return { params, key: stored, id: JSON.stringify(params) };
	}

	/**
	 * A stored row as reads return it: booleans from 0 and 1, `opt(...)` columns absent when `NULL`, `json(...)` cells
	 * parsed and migrated on access (a cell the code cannot read throws, see `JsonColumn.read`).
	 */
	decode(stored: { readonly [column: string]: SqliteValue }, context: Context): { [column: string]: unknown } {
		const row: { [column: string]: unknown } = {};
		for (const column of this.#columns) {
			const value = stored[column.name];
			if (value === null || value === undefined) continue;
			if (column.type === "bool") row[column.name] = value === 1;
			else if (column.type === "json") {
				const version = stored[versionColumn(column.name)] as number;
				row[column.name] = column.json.read(value as string, version, `${this.#table}.${column.name}`, context);
			} else row[column.name] = value;
		}
		return row;
	}

	/** `value`'s own fields when it is a plain object with only fields of `names`; `invalid/args` otherwise. */
	#closed(value: unknown, names: ReadonlySet<string>, what: string): { readonly [field: string]: unknown } {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw invalid("args", `${what}: expected an object`);
		}
		for (const field of Object.keys(value)) {
			if (!names.has(field)) throw invalid("args", `${what}: unknown column "${field}"`);
		}
		// Checked above: a plain object with known fields.
		return value as { readonly [field: string]: unknown };
	}
}

/** A checked cell: what is bound and what is recorded. */
type Cell = { readonly param: SqliteValue; readonly stored: Scalar | JsonValue };

/** Checks and encodes a value of `column`; a `json(...)` value is serialized, not walked (R9). */
export function encodeCell(column: Column, value: unknown, what: string): Cell {
	if (column.type !== "json") {
		const stored = checkScalar(column.type, value, what);
		return { param: toSqlite(stored), stored };
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw invalid("args", `${what}: not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (text === undefined) throw invalid("args", `${what}: not JSON`);
	// `JSON.stringify` accepted it; the recorded value is the one serialized. It is kept, not copied or parsed back:
	// same-host values are immutable by convention, so the outbox serializing it again in the step records this text
	// (a plugin mutating a value after `tx.put` breaks that convention, as for any other value it hands over).
	return { param: text, stored: value as JsonValue };
}

/** Checks a scalar value of `column` and returns what is bound (booleans as 0 and 1). */
function encodeScalar(column: Column, value: unknown, what: string): string | number {
	if (column.type === "json") throw invalid("args", `${what}: a json(...) column has no scalar value`);
	return toSqlite(checkScalar(column.type, value, what));
}

/**
 * A value of a scalar column type as the store keeps it (a trust boundary): `str` well-formed without NUL, `int` a
 * safe integer, `num` finite, `bool` a boolean; `invalid/args` otherwise.
 */
export function checkScalar(type: "str" | "int" | "num" | "bool", value: unknown, what: string): Scalar {
	switch (type) {
		case "str":
			if (typeof value === "string") return storedText(value, what);
			break;
		case "int":
			if (Number.isSafeInteger(value)) return value as number;
			break;
		case "num":
			if (typeof value === "number" && Number.isFinite(value)) return value;
			break;
		case "bool":
			if (typeof value === "boolean") return value;
			break;
	}
	throw invalid("args", `${what}: ${JSON.stringify(value) ?? String(value)} is not a ${type} value`);
}
