// `evolveTable(previous, (t) => t…)` (slice 6a §9; decision "Second spec review: the majority"): the next version of a
// table from the edits of one migration. The editor's types order the edits (`rename`, `add` and `json` before the
// data step, `drop`, `index` and `dropIndex` after it) and track the columns and key through the chain; at runtime one
// editor records the edits, checks each as it is made, and materializes the new version at the end.

import type { TOptional } from "typebox";
import { opt, type TSchema } from "../contracts/index.ts";
import { editWith, type Increment } from "../contracts/internal.ts";
import {
	type ColumnSchema,
	type Columns,
	type ColumnTypeOf,
	checkColumnName,
	columnRecord,
	describeColumns,
	type OrderColumn,
	type RowOf,
	type ValueOf,
} from "./columns.ts";
import { type Condition, compileSet, compileWhere, type SetOf } from "./expression.ts";
import type { ColumnRefs } from "./query.ts";
import { INDEX_NAME, orderColumns, TableDefinition, type TableOptions } from "./table.ts";
import type { DataStep, TableEdit } from "./table-history.ts";

/** The edits after the data step: `drop`, `index` and `dropIndex`; `C` and `K` are the columns and key so far. */
export interface TableTailEditor<C extends Columns, K extends readonly string[]> {
	/** Drops a non-key column; its indexes are dropped first, in the same commit. */
	drop<N extends Exclude<keyof C & string, K[number]>>(name: N): TableTailEditor<Without<C, N>, K>;
	/** Adds an index (`[a-z0-9_]+`) over non-`opt` `str` or `int` columns; it ends with the key. */
	index(name: string, columns: readonly OrderColumn<C>[]): TableTailEditor<C, K>;
	/** Drops an index. */
	dropIndex(name: string): TableTailEditor<C, K>;
	/** Type only: the columns and key so far. */
	readonly "~columns"?: C;
	readonly "~key"?: K;
}

/** The editor `evolveTable`'s edit gets: every edit; the column edits only before the data step. */
export interface TableEditor<C extends Columns, K extends readonly string[]> extends TableTailEditor<C, K> {
	/** Renames a column; the key, the indexes and a `json(...)` column's version column follow. */
	rename<F extends keyof C & string, T extends string>(
		from: F,
		to: T,
	): TableEditor<Renamed<C, F, T>, RenamedKey<K, F, T>>;
	/** Adds a column: `opt(...)`, or a scalar one with a `default` (existing rows get it). */
	add<N extends string, S extends AddedColumn>(name: N, column: S): TableEditor<With<C, N, S>, K>;
	/** A `json(...)` column's new version (its nullability kept): no DDL, no data step, cells migrate on access. */
	json<N extends JsonNames<C>, S extends ColumnSchema>(name: N, column: S): TableEditor<WithJson<C, N, S>, K>;
	/**
	 * The data step: `patch` gets each row as the columns stand here and returns new values of non-key columns (`{}`
	 * stamps the row only); synchronous and pure, run in chunks of 100 in key order.
	 */
	rows(patch: (row: RowOf<C>) => PatchOf<C, K>): TableTailEditor<C, K>;
	/** The data step as one `updateWhere` over the rows not migrated yet. */
	update(step: {
		readonly where?: (row: ColumnRefs<C>) => Condition;
		readonly set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>);
	}): TableTailEditor<C, K>;
}

/** A column `add` takes: `opt(...)` or one with a `default`. */
export type AddedColumn = ColumnSchema & (TOptional<TSchema> | { readonly default: unknown });

/** A `rows` patch: new values of non-key columns; `undefined` clears an `opt(...)` one. */
export type PatchOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in Exclude<keyof C & string, K[number]>]?: ValueOf<C[P]>;
};

type Renamed<C extends Columns, F extends keyof C, T extends string> = {
	readonly [P in keyof C as P extends F ? T : P]: C[P];
};

type RenamedKey<K extends readonly string[], F, T extends string> = {
	readonly [I in keyof K]: K[I] extends F ? T : K[I];
};

type With<C extends Columns, N extends string, S extends ColumnSchema> = {
	readonly [P in keyof C | N]: P extends N ? S : C[P & keyof C];
};

type Without<C extends Columns, N extends keyof C> = { readonly [P in Exclude<keyof C, N>]: C[P] };

type JsonNames<C extends Columns> = { [P in keyof C]: ColumnTypeOf<C[P]> extends "json" ? P : never }[keyof C] & string;

type WithJson<C extends Columns, N extends keyof C & string, S extends ColumnSchema> = With<
	C,
	N,
	C[N] extends TOptional<TSchema> ? TOptional<S> : S
>;

/** `V + 1` for a literal version (contracts' `Increment<N>`); `number` stays `number`. */
type Next<V extends number> = number extends V
	? number
	: `${Increment<`${V}`>}` extends `${infer N extends number}`
		? N
		: number;

/**
 * Appends the next version (`previous.version + 1`) with the edits `edit` makes; `edit` must return the editor it was
 * given. Every version is materialized and fingerprinted here; the object serves the newest, and its activation
 * migrates a store at an older version through each one.
 */
export function evolveTable<
	C extends Columns,
	K extends readonly string[],
	V extends number,
	E extends { readonly "~columns"?: Columns; readonly "~key"?: readonly string[] },
>(
	previous: TableDefinition<C, K, V>,
	edit: (t: TableEditor<C, K>) => E,
): TableDefinition<NonNullable<E["~columns"]>, NonNullable<E["~key"]>, Next<V>> {
	// The runtime editor works on untyped definitions; the types live in the editor interfaces.
	const editor = new Editor(previous as unknown as TableDefinition);
	// The editor interfaces track the edits in the types; at runtime every edit returns the same editor.
	editWith(editor as unknown as TableEditor<C, K>, edit, `${previous.name}: evolveTable`);
	return editor.finish() as unknown as TableDefinition<NonNullable<E["~columns"]>, NonNullable<E["~key"]>, Next<V>>;
}

/**
 * The editor at runtime: the columns, key and indexes as the edits leave them, the edits before and after the data
 * step, and the step. Each edit is checked as it is made (declaration policy: JavaScript callers reach the checks).
 */
class Editor {
	readonly #previous: TableDefinition;
	readonly #what: string;
	#schemas: { [name: string]: ColumnSchema };
	#key: string[];
	readonly #indexes: Map<string, readonly string[]>;
	/** `before` until the data step or the first `drop`, `index` or `dropIndex`. */
	#phase: "before" | "after" = "before";
	readonly #before: TableEdit[] = [];
	#step: DataStep | undefined;
	readonly #after: TableEdit[] = [];

	constructor(previous: TableDefinition) {
		this.#previous = previous;
		this.#what = `${previous.name} version ${previous.version + 1}`;
		this.#schemas = { ...previous.schemas };
		this.#key = [...previous.key];
		this.#indexes = new Map(previous.indexes);
	}

	rename(from: string, to: string): this {
		this.#assertBefore("rename");
		this.#assertColumn(from, "rename");
		// Checked here, not by the final definition: a later edit may rename it again, but this one runs as DDL.
		checkColumnName(to, `${this.#what}: rename`);
		this.#assertNewName(to, "rename", from);
		const rename = (column: string): string => (column === from ? to : column);
		this.#schemas = Object.fromEntries(Object.entries(this.#schemas).map(([name, schema]) => [rename(name), schema]));
		this.#key = this.#key.map(rename);
		for (const [name, columns] of this.#indexes) this.#indexes.set(name, columns.map(rename));
		this.#before.push({ kind: "rename", from, to });
		return this;
	}

	add(name: string, column: ColumnSchema): this {
		this.#assertBefore("add");
		this.#assertNewName(name, "add");
		const [described] = describeColumns({ [name]: column }, `${this.#what}: add`);
		if (!described!.optional && (described!.type === "json" || described!.default === undefined)) {
			throw new Error(`${this.#what}: add: column "${name}" needs opt(...) or a default (existing rows get it)`);
		}
		this.#schemas[name] = column;
		this.#before.push({ kind: "add", name, column: columnRecord(described!) });
		return this;
	}

	json(name: string, column: ColumnSchema): this {
		this.#assertBefore("json");
		const existing = describeColumns({ [name]: this.#assertColumn(name, "json") }, this.#what)[0]!;
		if (existing.type !== "json") throw new Error(`${this.#what}: json: column "${name}" is not a json(...) column`);
		if (Object.hasOwn(column, "~optional")) {
			throw new Error(`${this.#what}: json: pass json(...) itself; the column keeps its nullability`);
		}
		const schema = existing.optional ? opt(column) : column;
		const described = describeColumns({ [name]: schema }, `${this.#what}: json`)[0]!;
		if (described.type !== "json") throw new Error(`${this.#what}: json: expected a json(...) column`);
		const [before, after] = [existing.json, described.json];
		// D9 across table versions: a cell's version says which schema it was written with.
		if (after.version < before.version) {
			throw new Error(`${this.#what}: json: column "${name}" goes back from version ${before.version}`);
		}
		if (after.version === before.version && after.fingerprint !== before.fingerprint) {
			throw new Error(
				`${this.#what}: json: column "${name}" changes its schema at version ${before.version} (raise its version)`,
			);
		}
		this.#schemas[name] = schema;
		this.#before.push({ kind: "json", name, column: columnRecord(described) });
		return this;
	}

	rows(patch: (row: { readonly [column: string]: unknown }) => unknown): this {
		this.#assertBefore("rows");
		if (typeof patch !== "function") throw new Error(`${this.#what}: rows: expected a function`);
		this.#step = { kind: "rows", table: this.#current(), patch };
		this.#phase = "after";
		return this;
	}

	update(step: { readonly where?: unknown; readonly set: unknown }): this {
		this.#assertBefore("update");
		const table = this.#current();
		const what = `version ${table.version} update`;
		const where = typeof step.where === "function" ? step.where(table.refs) : step.where;
		const set = typeof step.set === "function" ? step.set(table.refs) : step.set;
		this.#step = {
			kind: "update",
			table,
			where: where === undefined ? undefined : compileWhere(table, where, what),
			set: compileSet(table, set, what),
		};
		this.#phase = "after";
		return this;
	}

	drop(name: string): this {
		this.#phase = "after";
		this.#assertColumn(name, "drop");
		if (this.#key.includes(name)) throw new Error(`${this.#what}: drop: "${name}" is a key column`);
		for (const [index, columns] of this.#indexes) {
			if (!columns.includes(name)) continue;
			this.#indexes.delete(index);
			this.#after.push({ kind: "dropIndex", name: index });
		}
		const { [name]: _dropped, ...schemas } = this.#schemas;
		this.#schemas = schemas;
		this.#after.push({ kind: "drop", name });
		return this;
	}

	index(name: string, columns: readonly string[]): this {
		this.#phase = "after";
		const what = `${this.#what}: index "${name}"`;
		if (!INDEX_NAME.test(name)) throw new Error(`${what}: expected [a-z0-9_]+`);
		if (this.#indexes.has(name)) throw new Error(`${what} exists`);
		// Checked against the columns at this edit: the migration creates the index here, whatever later edits do.
		const byName = new Map(describeColumns(this.#schemas, this.#what).map((column) => [column.name, column]));
		const checked = orderColumns(byName, columns, what);
		this.#indexes.set(name, checked);
		this.#after.push({ kind: "index", name, columns: checked });
		return this;
	}

	dropIndex(name: string): this {
		this.#phase = "after";
		if (!this.#indexes.delete(name)) throw new Error(`${this.#what}: dropIndex: no index "${name}"`);
		this.#after.push({ kind: "dropIndex", name });
		return this;
	}

	/** The new version, materialized and fingerprinted, linked to the previous one and the migration from it. */
	finish(): TableDefinition {
		const migration = { before: this.#before, step: this.#step, after: this.#after };
		return new TableDefinition(this.#previous.name, this.#options(), { previous: this.#previous, migration });
	}

	/** The table as the edits so far leave it, at the new version: what a data step reads and writes. */
	#current(): TableDefinition {
		return new TableDefinition(this.#previous.name, this.#options());
	}

	#options(): TableOptions<Columns, readonly never[]> {
		const version = this.#previous.version + 1;
		const options = {
			version,
			columns: { ...this.#schemas },
			key: [...this.#key],
			indexes: Object.fromEntries(this.#indexes),
		};
		// The key and indexes are names the edits kept; the constructor checks them as it checks a base's.
		return options as unknown as TableOptions<Columns, readonly never[]>;
	}

	#assertBefore(edit: string): void {
		if (this.#phase === "after") {
			throw new Error(`${this.#what}: ${edit} comes before the data step and before drop, index and dropIndex`);
		}
	}

	/**
	 * `name` names no column yet, also ignoring ASCII case (SQLite's column names do): checked per edit, since a later
	 * `drop` cannot take back an `add` the migration runs first. A rename may change only the case of `from`.
	 */
	#assertNewName(name: string, edit: string, from?: string): void {
		const folded = foldAscii(name);
		for (const existing of Object.keys(this.#schemas)) {
			if (existing !== from && foldAscii(existing) === folded) {
				throw new Error(
					`${this.#what}: ${edit}: column "${existing}" exists (names differing only in case collide)`,
				);
			}
		}
	}

	#assertColumn(name: string, edit: string): ColumnSchema {
		if (!Object.hasOwn(this.#schemas, name)) throw new Error(`${this.#what}: ${edit}: no column "${name}"`);
		return this.#schemas[name]!;
	}
}

/** `name` with ASCII letters lowercased and nothing else changed, as SQLite folds identifiers. */
function foldAscii(name: string): string {
	return name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}
