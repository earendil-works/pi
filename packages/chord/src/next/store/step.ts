// The commit step's working state (slice 6a §3, slice 6b §1.3) and the shape every write takes into it: a write staged
// before the queue (serialized, rule 8), applied inside the step, returning the writes it recorded.

import type { SqliteExecutor, SqliteValue } from "../../sqlite/index.ts";
import type { IdAllocator } from "./allocator.ts";
import type { TableRecord } from "./catalog.ts";
import type { StoreWrite } from "./writes.ts";

/**
 * Where a staged write goes in its commit: retirements, creations, then everything else, each phase in staging order.
 * A retirement frees a live address before a creation takes it (the partial unique index); an adapter's composite
 * write orders its own parts inside `write`.
 */
export type WriteOrder = "retire" | "create" | "write";

/** A write staged for the commit step: its order and what it does there, returning the writes as recorded. */
export type StagedWrite = {
	readonly order: WriteOrder;
	/**
	 * Applies the write inside the step's backend transaction; resolves with the writes as the outbox records them, in
	 * the order applied, with what only the step knows resolved (its seq, a record's revision).
	 */
	apply(step: Step): Promise<readonly StoreWrite[]>;
};

/**
 * One commit step: its backend transaction, its seq, the store's id allocator (D3: ids are taken from it as the
 * writes apply, never copied), the ids of the documents it created, the table records it changed (the store's catalog
 * takes them after `COMMIT`) and the statements it ran (`chord.store.statements`). Its reads are the step reader of
 * adapters: they see the step's own writes.
 */
export class Step {
	readonly executor: SqliteExecutor;
	readonly seq: number;
	readonly ids: IdAllocator;
	/** The ids of the commit's created documents, in the order of their writes. */
	readonly created: number[] = [];
	/** The table records this step changed, by SQL name. */
	readonly tables = new Map<string, TableRecord>();
	readonly #catalog: ReadonlyMap<string, TableRecord>;
	statements = 0;

	constructor(executor: SqliteExecutor, seq: number, ids: IdAllocator, catalog: ReadonlyMap<string, TableRecord>) {
		this.executor = executor;
		this.seq = seq;
		this.ids = ids;
		this.#catalog = catalog;
	}

	/** The record of table `name` as this step leaves it so far. */
	table(name: string): TableRecord | undefined {
		return this.tables.get(name) ?? this.#catalog.get(name);
	}

	/** Runs one statement. */
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.statements++;
		return this.executor.run(sql, ...params);
	}

	/** Runs one statement and resolves with the rows it changed. */
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		this.statements++;
		return this.executor.runCounted(sql, ...params);
	}

	/** Runs one query for its first row. */
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.statements++;
		return this.executor.get<T>(sql, ...params);
	}

	/** Runs one query. */
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.statements++;
		return this.executor.all<T>(sql, ...params);
	}
}
