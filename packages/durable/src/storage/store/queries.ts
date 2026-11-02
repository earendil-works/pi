// StoreStorage's reads as the store's queries (slice 6b D2, §2.4), compiled once from the store's query vocabulary
// into SQL over the declared tables: no SQL is rendered per call, and a read selects only the record cell (by id, an
// entry's commit seq too; each column returned costs) and parses one JSON text per record, as `SqliteStorage`'s do.

import type { Context } from "@earendil-works/chord";
import type { Order, OwnerTable, WhereNode } from "@earendil-works/chord/next";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import type { CommitTables } from "./commit.ts";

/**
 * A stored row as a query selects it: the record cell, its version (selected only once the column has versions past
 * 1), and an entry's commit seq.
 */
type RecordRow = { readonly record: string; readonly record$v?: number; readonly commit_seq?: number };

/** One condition of a read: a column, how it compares, its value; a call site keeps one order of them. */
export type Condition = readonly [string, "eq" | "gt" | "lt" | "gte" | "lte", SqliteValue];

const ASCENDING: Order = { columns: ["id"], direction: "asc" };
const DESCENDING: Order = { columns: ["id"], direction: "desc" };

/** The columns of a read of ids only. */
const ID = ["id"];

/** A placeholder value: a query's shape binds its values at each call. */
const ANY = 0;

/**
 * One table's compiled reads: by id (with the `byIdExtra` columns), and by shape (conditions in binding order, an
 * order; the record only), each shape compiled at its first use.
 */
export class TableQueries {
	readonly #table: OwnerTable;
	/** The record column's read of a cell at a version past 1; `undefined` while the column is at version 1. */
	readonly #versioned: ((text: string, version: number, context: Context) => unknown) | undefined;
	readonly #byId: string;
	readonly #shapes = new Map<string, string>();
	readonly #columns: readonly string[];

	constructor(table: OwnerTable, byIdExtra: readonly string[] = []) {
		this.#table = table;
		const versioned = table.jsonVersion("record") > 1;
		this.#versioned = versioned ? table.reader("record") : undefined;
		this.#columns = versioned ? ["record", "record$v"] : ["record"];
		this.#byId = table.prepareGet([...this.#columns, ...byIdExtra]);
	}

	/** The row with `id`, `undefined` when absent. */
	byId(executor: Pick<SqliteExecutor, "get">, id: number): Promise<RecordRow | undefined> {
		return executor.get<RecordRow>(this.#byId, id);
	}

	/** Up to `limit` rows whose `conditions` hold, by id in `direction`. */
	select(
		executor: Pick<SqliteExecutor, "all">,
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
		limit: number,
	): Promise<RecordRow[]> {
		const sql = this.#shape(conditions, direction, "many");
		return executor.all<RecordRow>(sql, ...conditions.map(([, , value]) => value), limit);
	}

	/** The first row whose `conditions` hold, by id in `direction`; `undefined` when none does. */
	first(
		executor: Pick<SqliteExecutor, "get">,
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
	): Promise<RecordRow | undefined> {
		const sql = this.#shape(conditions, direction, "first");
		return executor.get<RecordRow>(sql, ...conditions.map(([, , value]) => value));
	}

	/** A row's record, read as its column's (version checked, migrated on access). */
	record<T>(row: RecordRow, context: Context): T {
		const versioned = this.#versioned;
		// The cell holds a record of this table the storage wrote; at version 1 it is that JSON (`OwnerTable.reader`).
		return (versioned === undefined ? JSON.parse(row.record) : versioned(row.record, row.record$v!, context)) as T;
	}

	/** Appends the records of `rows` to `into`, in order, each read as `record` reads it (one check per call). */
	records<T>(rows: readonly RecordRow[], into: T[], context: Context): void {
		const versioned = this.#versioned;
		if (versioned === undefined) {
			for (const row of rows) into.push(JSON.parse(row.record) as T);
			return;
		}
		for (const row of rows) into.push(versioned(row.record, row.record$v!, context) as T);
	}

	/** The compiled read of a shape: its conditions' columns and comparisons, the direction, one row or many. */
	#shape(conditions: readonly Condition[], direction: "ascending" | "descending", rows: "first" | "many"): string {
		let key = `${rows} ${direction}`;
		for (const [column, condition] of conditions) key += ` ${column} ${condition}`;
		let sql = this.#shapes.get(key);
		if (sql !== undefined) return sql;
		// One comparison per condition: the vocabulary's node of that name, its value a placeholder.
		const nodes = conditions.map(([column, condition]) => ({ [condition]: [column, ANY] }) as unknown as WhereNode);
		const where: WhereNode | undefined = nodes.length === 0 ? undefined : { and: nodes };
		const order = direction === "ascending" ? ASCENDING : DESCENDING;
		sql =
			rows === "first"
				? this.#table.prepareFirst(this.#columns, where, order)
				: this.#table.prepare(this.#columns, where, order);
		this.#shapes.set(key, sql);
		return sql;
	}
}

/** The compiled reads of the storage's tables. */
export type StorageQueries = {
	readonly conversations: TableQueries;
	readonly entries: TableQueries;
	/** The id of a conversation's newest entry with a head marker: any, or at or before an id (bound second). */
	readonly latestHead: { readonly any: string; readonly atOrBefore: string };
	readonly tasks: TableQueries;
	readonly submissions: TableQueries;
};

/** The reads of `tables`. */
export function storageQueries(tables: CommitTables): StorageQueries {
	const heads = tables.entryHeads;
	return {
		conversations: new TableQueries(tables.conversations),
		entries: new TableQueries(tables.entries, ["commit_seq"]),
		latestHead: {
			any: heads.prepareFirst(ID, { eq: ["conversation_id", ANY] }, DESCENDING),
			atOrBefore: heads.prepareFirst(
				ID,
				{ and: [{ eq: ["conversation_id", ANY] }, { lte: ["id", ANY] }] },
				DESCENDING,
			),
		},
		tasks: new TableQueries(tables.tasks),
		submissions: new TableQueries(tables.submissions),
	};
}
