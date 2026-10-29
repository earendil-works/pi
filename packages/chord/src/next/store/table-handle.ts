// Table handles (slice 6a §6; decision "Query runner"): what `self.table(Def)` returns, one per attempt and table: reads
// of committed rows (`page`, `rows`, `get`, `count`) through the store's guarded reads, and what a transaction's
// writes to the table are staged with.

import type { Context } from "../../context/index.ts";
import type { SqliteValue } from "../../sqlite/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { Columns, RowOf } from "./columns.ts";
import { decodeCursor, encodeCursor, type Query } from "./query.ts";
import { TableSql } from "./sql.ts";
import type { ChordStore } from "./store.ts";
import type { KeyOf, TableDefinition } from "./table.ts";

/** One page of rows (`items`, as Durable's pages) and, when more follow, the cursor to continue after it. */
export type Page<T> = { readonly items: T[]; readonly next?: string };

/** What `page` takes besides the query, the limit and the context. */
export type PageOptions = {
	/** A cursor from an earlier page of the same order. */
	readonly after?: string;
};

/** A table of this object: reads of committed state, the context last. Writes go through `self.tx`. */
export interface Table<C extends Columns, K extends readonly string[]> {
	/** Up to `limit` rows of `q` (after `options.after`), and the cursor of the next page when there is one. */
	page(q: Query<C, K>, limit: number, context: Context, options?: PageOptions): Promise<Page<RowOf<C>>>;
	/** Every row of `q`, read a page of 100 at a time. */
	rows(q: Query<C, K>, context: Context): AsyncIterable<RowOf<C>>;
	/** The row with `key`, `undefined` when absent. */
	get(key: KeyOf<C, K>, context: Context): Promise<RowOf<C> | undefined>;
	/** The number of rows of `q`. */
	count(q: Query<C, K>, context: Context): Promise<number>;
}

/** The handle type of table definition `D`: what `self.table(D)` returns. */
export type TableOf<D> = D extends TableDefinition<infer C, infer K> ? Table<C, K> : never;

/** Who owns a table handle: its object (whose transactions alone write it), liveness check and live failure. */
export type TableOwner = {
	readonly label: string;
	/** The object's documents: a transaction of another object refuses the handle. */
	readonly scope: object;
	/** Throws `released` once the object ended. */
	assertLive(): void;
	/** A row the code cannot read (a `json(...)` cell, slice 6a §9) fails the owner `broken` (§1.4). */
	fail(error: ChordError): void;
};

/** The rows `rows()` reads per page (rule 17). */
export const ROWS_PAGE = 100;

/** A table handle: the definition the attempt declared, the table's SQL name and statements, the store. */
export class TableHandle implements Table<Columns, readonly string[]> {
	readonly definition: TableDefinition;
	readonly sql: TableSql;
	readonly store: ChordStore;
	readonly owner: TableOwner;

	constructor(definition: TableDefinition, sqlName: string, store: ChordStore, owner: TableOwner) {
		this.definition = definition;
		this.sql = new TableSql(sqlName, definition.columns, definition.rows.physical, definition.key);
		this.store = store;
		this.owner = owner;
	}

	async page(q: Query, limit: number, context: Context, options: PageOptions = {}): Promise<Page<RowOf<Columns>>> {
		this.owner.assertLive();
		this.#assertQuery(q);
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw invalid("args", `${this.definition.name}: limit is a positive integer`);
		const order = q.order;
		const after =
			options.after === undefined ? undefined : decodeCursor(this.definition, this.sql.table, order, options.after);
		const statement = this.sql.select(q.condition, order, after, limit + 1);
		const stored = await this.store.read(
			(executor) => executor.all<{ [column: string]: SqliteValue }>(statement.sql, ...statement.params),
			context,
		);
		const more = stored.length > limit;
		if (more) stored.length = limit;
		const items = stored.map((row) => this.decode(row, context));
		if (!more) return { items };
		const last = stored[limit - 1]!;
		return {
			items,
			next: encodeCursor(
				this.sql.table,
				order,
				order.columns.map((column) => last[column]!),
			),
		};
	}

	async *rows(q: Query, context: Context): AsyncIterable<RowOf<Columns>> {
		let after: string | undefined;
		do {
			const page = await this.page(q, ROWS_PAGE, context, after === undefined ? {} : { after });
			yield* page.items;
			after = page.next;
		} while (after !== undefined);
	}

	async get(key: unknown, context: Context): Promise<RowOf<Columns> | undefined> {
		this.owner.assertLive();
		const encoded = this.definition.rows.key(key, "get");
		const stored = await this.store.read(
			(executor) => executor.get<{ [column: string]: SqliteValue }>(this.sql.get, ...encoded.params),
			context,
		);
		return stored === undefined ? undefined : this.decode(stored, context);
	}

	async count(q: Query, context: Context): Promise<number> {
		this.owner.assertLive();
		this.#assertQuery(q);
		const statement = this.sql.count(q.condition);
		const row = await this.store.read(
			(executor) => executor.get<{ readonly count: number }>(statement.sql, ...statement.params),
			context,
		);
		return row?.count ?? 0;
	}

	/** A stored row as reads return it; one the code cannot read fails the owner and throws. */
	decode(stored: { readonly [column: string]: SqliteValue }, context: Context): RowOf<Columns> {
		try {
			// The codec decodes by the definition's columns: a row of them.
			return this.definition.rows.decode(stored, context) as RowOf<Columns>;
		} catch (error) {
			const failure =
				error instanceof ChordError
					? error
					: new ChordError({ code: "unavailable", message: String(error) }, { cause: error });
			this.owner.fail(failure);
			throw failure;
		}
	}

	/** A query of another table is refused (`invalid/args`). */
	#assertQuery(q: Query): void {
		if (q.table !== this.definition) {
			throw invalid(
				"args",
				`${this.owner.label}: a query of table "${q.table.name}" run on "${this.definition.name}"`,
			);
		}
	}
}
