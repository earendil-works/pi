// Table definitions (slice 6a §5, §9; decisions "Flat columns", "Restricted names", "Index definitions are recorded"):
// `defineTable(name, { version, columns, key, indexes? })`, checked and materialized once at declaration: its columns,
// its key, its indexes, its fingerprint and the compiled row codec its writes and reads use. A version `evolveTable`
// appends links to the one before it and to the migration between them.

import { checkName, hash64 } from "../contracts/internal.ts";
import {
	type Column,
	type ColumnRecord,
	type Columns,
	columnRecord,
	describeColumns,
	type OrderColumn,
} from "./columns.ts";
import { type ColumnRef, columnRefs } from "./expression.ts";
import { RowCodec } from "./rows.ts";
import type { Migration } from "./table-history.ts";

/** What `defineTable` takes. */
export type TableOptions<C extends Columns, K extends readonly OrderColumn<C>[], V extends number = number> = {
	/** The table's version: a positive integer, raised by every change (`evolveTable`). */
	readonly version: V;
	readonly columns: C;
	/** The primary key's columns, non-`opt` `str` or `int` ones. */
	readonly key: K;
	/** Secondary indexes by name (`[a-z0-9_]+`); each ends with the primary key. */
	readonly indexes?: { readonly [name: string]: readonly OrderColumn<C>[] };
};

/** The key of a row of a table with columns `C` and key `K`: an object with exactly the key columns. */
export type KeyOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in K[number]]: P extends keyof C
		? C[P] extends { readonly "~kind": "Integer" }
			? number
			: string
		: never;
};

/**
 * Declares a table: a base version written in full, the first of its history. Later versions come from
 * `evolveTable`; a new base starts a new history.
 */
export function defineTable<C extends Columns, const K extends readonly OrderColumn<C>[], const V extends number>(
	name: string,
	options: TableOptions<C, K, V>,
): TableDefinition<C, K, V> {
	return new TableDefinition(name, options);
}

/** The table form's version: the fingerprints of table definitions are persisted, so their input is versioned. */
export const TABLE_FORM_VERSION = 1;

/** The index name rule. */
export const INDEX_NAME = /^[a-z0-9_]+$/;

/** How a version came about: the version before it and the migration from there, for one `evolveTable`. */
export type Evolution = { readonly previous: TableDefinition; readonly migration: Migration };

/**
 * A declared table at one version: its columns in declaration order, key, indexes (declared columns; the key is
 * appended when they are rendered), the fingerprint of all of it and the row codec. `C` and `K` type its rows and keys,
 * `V` its version.
 */
export class TableDefinition<
	C extends Columns = Columns,
	K extends readonly string[] = readonly string[],
	V extends number = number,
> {
	readonly name: string;
	readonly version: V;
	/** The column schemas as declared, which `evolveTable` edits into the next version's. */
	readonly schemas: Columns;
	readonly columns: readonly Column[];
	readonly byName: ReadonlyMap<string, Column>;
	readonly key: readonly string[];
	readonly indexes: ReadonlyMap<string, readonly string[]>;
	/** `hash64` of the columns, key and indexes in `TABLE_FORM_VERSION`'s form. */
	readonly fingerprint: string;
	/** The columns as the `table` write records them. */
	readonly record: { readonly [name: string]: ColumnRecord };
	readonly rows: RowCodec;
	/** One reference per column, for the `(t) => …` callbacks of queries and writes. */
	readonly refs: { readonly [column: string]: ColumnRef };
	/** The version before this one and the migration from it; `undefined` for a base. */
	readonly evolution: Evolution | undefined;
	/** Type only: the columns and key. */
	declare readonly "~columns"?: C;
	declare readonly "~key"?: K;

	constructor(name: string, options: TableOptions<C, K & readonly OrderColumn<C>[], V>, evolution?: Evolution) {
		checkName(name, "table");
		const { version, columns, key, indexes = {} } = options;
		// Declaration policy: JavaScript callers reach these checks.
		if (!Number.isSafeInteger(version) || version < 1)
			throw new Error(`${name}: version ${version} is not a positive integer`);
		this.name = name;
		this.version = version;
		this.schemas = columns;
		this.columns = describeColumns(columns, name);
		this.byName = new Map(this.columns.map((column) => [column.name, column]));
		this.key = orderColumns(this.byName, key, `${name}: the key`);
		if (this.key.length === 0) throw new Error(`${name}: the key has no column`);
		this.indexes = new Map(
			Object.entries(indexes).map(([index, columns]) => {
				if (!INDEX_NAME.test(index)) throw new Error(`${name}: index "${index}": expected [a-z0-9_]+`);
				return [index, orderColumns(this.byName, columns, `${name}: index "${index}"`)] as const;
			}),
		);
		this.record = Object.fromEntries(this.columns.map((column) => [column.name, columnRecord(column)]));
		this.fingerprint = tableFingerprint(this.record, this.key, this.indexes);
		this.rows = new RowCodec(this.columns, this.key, name);
		this.refs = columnRefs(this.columns);
		this.evolution = evolution;
	}

	/** The column `name`; an unknown one throws (`what` names the use). */
	column(name: string, what: string): Column {
		const column = this.byName.get(name);
		if (column === undefined) throw new Error(`${this.name}: ${what}: no column "${name}"`);
		return column;
	}
}

/**
 * Checks `names` as key, index or order columns of a table whose columns are `byName`: existing, non-`opt` `str` or
 * `int`, no column twice (declaration policy: JavaScript callers reach it); `what` names the use in errors.
 */
export function orderColumns(
	byName: ReadonlyMap<string, Column>,
	names: readonly string[],
	what: string,
): readonly string[] {
	if (!Array.isArray(names)) throw new Error(`${what}: expected an array of column names`);
	if (new Set(names).size !== names.length) throw new Error(`${what}: a column occurs twice`);
	for (const name of names) {
		const column = byName.get(name);
		if (column === undefined) throw new Error(`${what}: no column "${name}"`);
		if (column.optional || (column.type !== "str" && column.type !== "int")) {
			throw new Error(`${what}: column "${name}" is not a non-opt str() or int() column`);
		}
	}
	return [...names];
}

/** The fingerprint of a table's columns, key and indexes; column and index names sorted (their order is no change). */
export function tableFingerprint(
	columns: { readonly [name: string]: ColumnRecord },
	key: readonly string[],
	indexes: ReadonlyMap<string, readonly string[]>,
): string {
	const value = { columns: sorted(Object.entries(columns)), key, indexes: sorted([...indexes]) };
	return hash64(JSON.stringify({ tableFormVersion: TABLE_FORM_VERSION, value }));
}

function sorted<T>(entries: [string, T][]): { [name: string]: T } {
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
