// Column sets (slice 14 §5): `defineColumns(name, { columns, key, indexes? })` in a plugin's contract file names the
// scalar columns of one of its tables that other plugins' conditions and joins may read, the table's key, and the
// indexes others may match by. A table spreads `...Set.columns` into its own and declares `exposes: Set`.

import { checkName } from "../contracts/internal.ts";
import { type Column, type Columns, columnRecord, describeColumns, type OrderColumn } from "./columns.ts";
import { ColumnRef } from "./expression.ts";
import type { ColumnRefs } from "./query.ts";
import { orderColumns } from "./table.ts";

/** What `defineColumns` takes. */
export type ColumnSetOptions<C extends Columns, K extends readonly OrderColumn<C>[]> = {
	/** The public columns: scalar ones (`str int num bool`, `opt(...)` of them, `host(...)`). */
	readonly columns: C;
	/** The key of the table that exposes the set. */
	readonly key: K;
	/** The indexes others may match by, each a leading prefix of one of the table's. */
	readonly indexes?: { readonly [name: string]: readonly OrderColumn<C>[] };
};

/** Declares the columns of a table that other plugins' conditions and joins may read. */
export function defineColumns<C extends Columns, const K extends readonly OrderColumn<C>[]>(
	name: string,
	options: ColumnSetOptions<C, K>,
): ColumnSet<C, K> {
	return new ColumnSet(name, options);
}

/**
 * A declared column set: its columns, key and indexes, checked once here. `refs` are its column references, for
 * conditions over the set wherever it appears (a query's own table, a joined set, an `exists`).
 */
export class ColumnSet<C extends Columns = Columns, K extends readonly string[] = readonly string[]> {
	readonly name: string;
	/** The column schemas as declared: what a table spreads into its own columns. */
	readonly columns: C;
	readonly byName: ReadonlyMap<string, Column>;
	readonly key: readonly string[];
	readonly indexes: ReadonlyMap<string, readonly string[]>;
	readonly refs: ColumnRefs<C>;
	/** Type only: the key. */
	declare readonly "~key"?: K;

	constructor(name: string, options: ColumnSetOptions<C, K & readonly OrderColumn<C>[]>) {
		checkName(name, "column set");
		const { columns, key, indexes = {} } = options;
		const described = describeColumns(columns, name);
		for (const column of described) {
			// Declaration policy: a `json(...)` cell has no scalar value a condition could compare.
			if (column.type === "json")
				throw new Error(`${name}: column "${column.name}": json(...) is not in a column set`);
		}
		this.name = name;
		this.columns = columns;
		this.byName = new Map(described.map((column) => [column.name, column]));
		this.key = orderColumns(this.byName, key, `${name}: the key`);
		if (this.key.length === 0) throw new Error(`${name}: the key has no column`);
		this.indexes = new Map(
			Object.entries(indexes).map(([index, names]) => [
				index,
				orderColumns(this.byName, names, `${name}: index "${index}"`),
			]),
		);
		// One reference per column, tagged with the set: a condition names the side it means by it.
		this.refs = Object.fromEntries(
			described.map((column) => [column.name, new ColumnRef(column.name, name)]),
		) as ColumnRefs<C>;
	}
}

/** The parts of a table definition `checkExposes` reads. */
type ExposingTable = {
	readonly name: string;
	readonly byName: ReadonlyMap<string, Column>;
	readonly key: readonly string[];
	readonly indexes: ReadonlyMap<string, readonly string[]>;
};

/**
 * Checks that `table` can expose `set` (declaration policy): every column of the set is a column of the table of
 * the same type and nullability, the keys are equal, and each index of the set is a leading prefix of the key or of one of the
 * table's indexes (which end with the key).
 */
export function checkExposes(table: ExposingTable, set: ColumnSet): void {
	const what = `${table.name}: exposes "${set.name}"`;
	for (const [name, column] of set.byName) {
		const own = table.byName.get(name);
		if (own === undefined) throw new Error(`${what}: the table has no column "${name}"`);
		if (!sameColumn(own, column)) throw new Error(`${what}: column "${name}" is declared differently in the table`);
	}
	if (JSON.stringify(table.key) !== JSON.stringify(set.key)) throw new Error(`${what}: the keys differ`);
	const paths = [table.key, ...[...table.indexes.values()].map((columns) => indexPath(columns, table.key))];
	for (const [index, columns] of set.indexes) {
		if (!paths.some((path) => columns.every((column, at) => path[at] === column))) {
			throw new Error(`${what}: index "${index}" is no leading prefix of the key or of an index of the table`);
		}
	}
}

/**
 * Refuses a table exposing a set another table declared by the same object exposes (declaration policy: a set name
 * is bound to one table), naming both.
 */
export function checkExposedOnce(
	definition: { readonly name: string; readonly exposes?: ColumnSet | undefined },
	declared: Iterable<{ readonly name: string; readonly exposes?: ColumnSet | undefined }>,
	label: string,
): void {
	const set = definition.exposes?.name;
	if (set === undefined) return;
	for (const other of declared) {
		if (other.exposes?.name === set) {
			throw new Error(`${label}: column set "${set}" is exposed by tables "${other.name}" and "${definition.name}"`);
		}
	}
}

/**
 * Whether two columns are the same to a reader: the type, whether `opt(...)`, a `host(...)` column's kind. A default
 * is the writer's business.
 */
export function sameColumn(a: Column, b: Column): boolean {
	const [x, y] = [columnRecord(a), columnRecord(b)];
	return x.type === y.type && x.optional === y.optional && x.host === y.host;
}

/** The columns an index is stored by: its own, then the key columns not among them. */
export function indexPath(columns: readonly string[], key: readonly string[]): readonly string[] {
	return [...columns, ...key.filter((column) => !columns.includes(column))];
}
