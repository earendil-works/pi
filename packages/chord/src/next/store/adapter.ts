// The store for adapters (slice 6b §2.1, D1, D2): what an owner outside Chord's objects (Durable's `StoreStorage`) uses
// to keep its data in the store as declared tables and engine documents: its tables declared and prepared under its
// owner name (claimed, the path `self.table` takes), rows encoded at staging and written in a step with what only the
// step knows, and its reads. Internal for adapters; apps use `openStore` and objects.

import type { Context } from "../../context/index.ts";
import type { SqliteExecutor, SqliteValue } from "../../sqlite/index.ts";
import { checkName } from "../contracts/internal.ts";
import type { Claimant } from "./claims.ts";
import type { WhereNode } from "./expression.ts";
import type { EncodedRow } from "./rows.ts";
import { type Order, TableSql, tableSqlName } from "./sql.ts";
import type { Step } from "./step.ts";
import type { ChordStore } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import { prepareTables } from "./table-migration.ts";
import type { TableWrite } from "./table-writes.ts";

/** A stored row as reads decode it. */
export type DecodedRow = { readonly [column: string]: unknown };

/**
 * The tables of one owner name in a store: each declared once (its SQL name `"<owner>:<table>"` claimed for
 * `claimant`), then prepared together (created at their newest version or migrated, as `self.table`'s are).
 */
export class StoreOwnerTables {
	readonly store: ChordStore;
	readonly owner: string;
	readonly #claimant: Claimant;
	readonly #tables: OwnerTable[] = [];

	/** `owner` is a restricted name (lowercase `[a-z0-9@/._~-]`): it becomes the first part of SQL names. */
	constructor(store: ChordStore, owner: string, claimant: Claimant) {
		checkName(owner, "An owner name");
		this.store = store;
		this.owner = owner;
		this.#claimant = claimant;
	}

	/** Declares `definition` under the owner, claiming its SQL name (held by another: `invalid/args`). */
	declare(definition: TableDefinition): OwnerTable {
		const table = new OwnerTable(definition, tableSqlName(this.owner, definition.name));
		this.store.claims.table(table.sql.table, this.#claimant);
		this.#tables.push(table);
		return table;
	}

	/** Brings every declared table to its definition: created fresh, or migrated eagerly in their commits. */
	prepare(context: Context): Promise<void> {
		const tables = this.#tables.map(({ definition, sql }) => ({ definition, table: sql.table }));
		const fence = { admit: () => true, adopt: () => {} };
		return prepareTables(tables, this.store, fence, this.owner, context);
	}
}

/** One declared table of an owner: its rows encoded and written in a step, its reads by key and by query. */
export class OwnerTable {
	readonly definition: TableDefinition;
	readonly sql: TableSql;

	constructor(definition: TableDefinition, table: string) {
		this.definition = definition;
		this.sql = new TableSql(table, definition.columns, definition.rows.physical, definition.key);
	}

	/** `row` checked and encoded for a `put` (a trust boundary, rule 8: at staging, before the queue). */
	encode(row: unknown): EncodedRow {
		return this.definition.rows.put(row, this.definition.version);
	}

	/**
	 * Writes `encoded` in `step` (an upsert) and returns the `put` as recorded; `stamp` names an `int` column that takes
	 * the step's seq (Durable's `entries.commit_seq`), in the row and in the record.
	 */
	async put(step: Step, encoded: EncodedRow, stamp?: string): Promise<TableWrite> {
		const { version } = this.definition;
		const { table } = this.sql;
		if (stamp === undefined) {
			await step.run(this.sql.put, ...encoded.params);
			return { kind: "put", table, row: encoded.row, version, columns: encoded.columns };
		}
		const params = [...encoded.params];
		params[this.definition.rows.physical.indexOf(stamp)] = step.seq;
		await step.run(this.sql.put, ...params);
		return { kind: "put", table, row: { ...encoded.row, [stamp]: step.seq }, version, columns: encoded.columns };
	}

	/** The row with the key `params` (in key order), decoded. */
	async get(
		executor: Pick<SqliteExecutor, "get">,
		params: readonly SqliteValue[],
		context: Context,
	): Promise<DecodedRow | undefined> {
		const stored = await executor.get<{ [column: string]: SqliteValue }>(this.sql.get, ...params);
		return stored === undefined ? undefined : this.definition.rows.decode(stored, context);
	}

	/**
	 * A read compiled once (the store's query vocabulary rendered to SQL): `columns` of the rows `where` matches in
	 * `order`. The values in `where` only shape it: each is a `?` the caller binds in the order the conditions take
	 * them, then the limit. Adapters keep their fixed reads so: no SQL is rendered per call.
	 */
	prepare(columns: readonly string[], where: WhereNode | undefined, order: Order): string {
		return this.sql.select(where, order, undefined, 0, columns).sql;
	}

	/** `prepare` for the first row only: the limit is a literal `1` (a bound one costs SQLite a plan step per call). */
	prepareFirst(columns: readonly string[], where: WhereNode | undefined, order: Order): string {
		return this.sql.select(where, order, undefined, 1, columns).sql.replace(/LIMIT \?$/, "LIMIT 1");
	}

	/**
	 * The version of `json(...)` column `column`: at 1 every stored cell is at 1 (none is older, a newer one fails the
	 * owner when its table is prepared), so a read may leave the version column out.
	 */
	jsonVersion(column: string): number {
		const found = this.definition.column(column, "jsonVersion");
		if (found.type !== "json") throw new Error(`${this.definition.name}: column "${column}" is no json(...) column`);
		return found.json.version;
	}

	/** A point lookup compiled once: `columns` of the row whose key the caller binds, in key order. */
	prepareGet(columns: readonly string[]): string {
		return this.sql.getColumns(columns);
	}

	/**
	 * The read of `json(...)` column `column`'s stored cells (`text` written at `version`, migrated on access), made
	 * once: an adapter selecting the cell itself reads it so.
	 */
	reader(column: string): (text: string, version: number, context: Context) => unknown {
		const found = this.definition.column(column, "reader");
		if (found.type !== "json") throw new Error(`${this.definition.name}: column "${column}" is no json(...) column`);
		// At version 1 a cell is the JSON it was written as: no version to compare, nothing to migrate.
		if (found.json.version === 1) return (text) => JSON.parse(text) as unknown;
		const what = `${this.sql.table}.${column}`;
		return (text, version, context) => found.json.read(text, version, what, context);
	}

	/** Up to `limit` rows matching `where` in `order`, decoded. */
	async select(
		executor: Pick<SqliteExecutor, "all">,
		where: WhereNode | undefined,
		order: Order,
		limit: number,
		context: Context,
	): Promise<DecodedRow[]> {
		const statement = this.sql.select(where, order, undefined, limit);
		const stored = await executor.all<{ [column: string]: SqliteValue }>(statement.sql, ...statement.params);
		return stored.map((row) => this.definition.rows.decode(row, context));
	}
}
