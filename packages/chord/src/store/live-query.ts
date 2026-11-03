// Live queries (decision "Live queries over an object's own tables"): `self.query(table, q, limit)`, a JSON watchable
// of a query's rows over a table of the object itself. Run once before the object goes live, then again inside the
// commit step of every commit of the object that wrote the table (after its writes, so it sees them) and published in
// that commit's batch as the diff from the previous rows (W1). Only the object writes its tables, so its commits are
// the exact invalidation; a commit writing no table with a live query runs none.

import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { diffRevisions, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { type Batch, handedOut, Source, type WatchStart } from "../state/internal.ts";
import type { Query } from "./query.ts";
import type { Statement } from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { TableDefinition } from "./table.ts";
import type { TableHandle } from "./table-handle.ts";
import type { StoreWrite } from "./writes.ts";

/** Who a live query belongs to: its object, and where its failures after activation are reported (`query_failed`). */
export type QueryOwner = {
	readonly label: string;
	report(error: unknown): void;
};

/**
 * The rows of one run: in order, and by key with the stored row each was decoded from, which the next run compares
 * against to keep an unchanged row the same object.
 */
type Rows = { readonly value: JsonValue[]; readonly byKey: ReadonlyMap<unknown, Decoded> };

/** A row as a run decoded it, with the stored row it came from. */
type Decoded = { readonly stored: StoredRow; readonly row: JsonValue };

/** One run of a live query in a commit step: its rows, or why it could not read them. */
type QueryRun = { readonly kind: "rows"; readonly rows: Rows } | { readonly kind: "failed"; readonly error: unknown };

/**
 * Where a live query stands: before its first run (activation), with rows, failed (its last run threw; its last good
 * rows kept for a watch opened meanwhile), or detached (its attempt ended).
 */
type QueryState =
	| { readonly kind: "loading" }
	| { readonly kind: "rows"; readonly value: JsonValue[] }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue[] | undefined }
	| { readonly kind: "detached"; readonly error: unknown };

/** A stored row as the backend returns it. */
type StoredRow = { readonly [column: string]: SqliteValue };

/**
 * Refuses what the types cannot (plugin code is bundled without type checks; declaration policy): a query of another
 * table than `table`, and a `limit` that is no positive integer (a live query must be bounded: one run per commit
 * that writes its table reads at most `limit` rows).
 */
export function checkLiveQuery(table: TableDefinition, q: Query, limit: unknown, label: string): void {
	if (q.table !== table) {
		throw invalid("args", `${label}: self.query: a query of table "${q.table.name}" over "${table.name}"`);
	}
	if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
		throw invalid("args", `${label}: self.query: a limit is required, a positive integer`);
	}
}

/** The live queries of one object by table (its SQL name), across its attempts: what its commits re-run. */
export class LiveQueries {
	readonly #byTable = new Map<string, Set<LiveQuery>>();

	/** Adds `query` (its attempt declared it): re-run by every commit writing its table from now on. */
	add(query: LiveQuery): void {
		const table = query.handle.sql.table;
		let queries = this.#byTable.get(table);
		if (queries === undefined) {
			queries = new Set();
			this.#byTable.set(table, queries);
		}
		queries.add(query);
	}

	/** Removes `query` (its attempt ended). */
	delete(query: LiveQuery): void {
		const table = query.handle.sql.table;
		const queries = this.#byTable.get(table);
		if (queries === undefined) return;
		queries.delete(query);
		if (queries.size === 0) this.#byTable.delete(table);
	}

	/** The live queries over `table`, if any. */
	on(table: string): ReadonlySet<LiveQuery> | undefined {
		return this.#byTable.get(table);
	}
}

/**
 * The re-run of the live queries over the tables a transaction writes (`handles`), `undefined` when none has one (the
 * common case: a map lookup per written table, nothing more). `context` is the transaction's: the runs count through it.
 */
export function refreshOf(handles: Iterable<TableHandle>, context: Context): QueryRefresh | undefined {
	let queries: Set<LiveQuery> | undefined;
	for (const handle of handles) {
		const on = handle.owner.queries.on(handle.sql.table);
		if (on === undefined) continue;
		queries ??= new Set();
		for (const query of on) queries.add(query);
	}
	return queries === undefined ? undefined : new QueryRefresh([...queries], context);
}

const NO_WRITES: readonly StoreWrite[] = [];

/**
 * The re-run of live queries in one commit: `write` reads them in the commit step after the commit's own writes (the
 * last write of the last phase), and `adopt` publishes their rows in the commit's batch; a refused step adopts nothing.
 * A transaction stages it as its own change (`Staged`).
 */
export class QueryRefresh {
	readonly #queries: readonly LiveQuery[];
	readonly #context: Context;
	readonly #runs: QueryRun[] = [];
	/** The staged write that reads the queries; it writes nothing and records nothing in the outbox. */
	readonly write: StagedWrite;

	constructor(queries: readonly LiveQuery[], context: Context) {
		this.#queries = queries;
		this.#context = context;
		this.write = { order: "write", apply: (step) => this.#rerun(step) };
	}

	async #rerun(step: Step): Promise<readonly StoreWrite[]> {
		for (const query of this.#queries) this.#runs.push(await query.rerun(step, this.#context));
		return NO_WRITES;
	}

	/** Publishes each query's new rows (or its failure), inside the commit's batch. */
	adopt(): void {
		for (const [index, query] of this.#queries.entries()) query.adopt(this.#runs[index]!);
	}

	committed(): void {}

	discarded(): void {}
}

/** What the watches of a failed live query had: no rows, so its next rows replace the value whole. */
const NO_VALUE: unique symbol = Symbol("no value");

const NO_ROWS: ReadonlyMap<unknown, Decoded> = new Map();

/**
 * A live query: the rows of `query` (at most `limit`, in its order) over its object's table `handle`, as a JSON source
 * (a state member, a derive source, an `on` source). Its statement is compiled once; each run decodes only the rows
 * whose stored columns changed and keeps the others the same objects, so its frame, the diff from the rows its watches
 * had, compares unchanged rows by identity (a window shifted by one row: one insert and one removal, not a comparison
 * of every row with every other).
 */
export class LiveQuery extends Source {
	readonly handle: TableHandle;
	readonly #owner: QueryOwner;
	readonly #statement: Statement;
	#state: QueryState = { kind: "loading" };
	/** The last adopted rows by key, with the stored rows they were decoded from (the next run reuses unchanged ones). */
	#byKey: ReadonlyMap<unknown, Decoded> = NO_ROWS;
	/** The rows this query's watches have, kept from its adoption to its frame in the batch; `undefined`: not listed. */
	#framed: JsonValue[] | typeof NO_VALUE | undefined;
	/** Commits adopted so far: an activation run that a commit overtook keeps the commit's newer rows. */
	#adopted = 0;
	/** Set from a failed run until the next good one: a failure episode is reported once. */
	#failing = false;

	constructor(handle: TableHandle, query: Query, limit: number, owner: QueryOwner, batch: Batch) {
		super(batch);
		this.handle = handle;
		this.#owner = owner;
		this.#statement = handle.sql.select(query.condition, query.order, undefined, limit);
	}

	get value(): JsonValue[] {
		const state = this.#state;
		if (state.kind === "rows") return state.value;
		if (state.kind === "loading") {
			throw new ChordError({ code: "not_ready", message: `${this.#owner.label}: a live query read before it ran` });
		}
		throw state.error;
	}

	/** Its rows, or while failed its failure and last good rows (a detached query throws). */
	override start(): WatchStart {
		const state = this.#state;
		if (state.kind === "failed") return { kind: "failed", error: state.error, last: state.last };
		return { kind: "value", value: this.value };
	}

	/**
	 * The first run, before its object goes live (activation, after its tables are prepared): a failure throws and fails
	 * the activation. Rows a commit adopted meanwhile are newer and stay.
	 */
	async load(context: Context): Promise<void> {
		const adopted = this.#adopted;
		this.#count(context);
		const { sql, params } = this.#statement;
		const stored = await this.handle.store.read((executor) => executor.all<StoredRow>(sql, ...params), context);
		// Decoded outside the store's read: a row the code cannot read is this query's failure, not the backend's.
		const rows = this.#decode(stored, context);
		if (this.#adopted !== adopted) return;
		this.#byKey = rows.byKey;
		this.#state = { kind: "rows", value: rows.value };
	}

	/** A run inside the commit step `step`, after its writes: the rows, or the failure; it never throws. */
	async rerun(step: Step, context: Context): Promise<QueryRun> {
		try {
			this.#count(context);
			const { sql, params } = this.#statement;
			return { kind: "rows", rows: this.#decode(await step.all<StoredRow>(sql, ...params), context) };
		} catch (error) {
			return { kind: "failed", error };
		}
	}

	/**
	 * Takes a commit's run, inside its batch: listed for a frame when watched, its dependents marked. A failed run makes
	 * the query a failed member (as a throwing derive): its watches get one failure call, the owner a report per
	 * failure episode; the next good run replaces the value whole.
	 */
	adopt(run: QueryRun): void {
		const state = this.#state;
		if (state.kind === "detached") return;
		this.#adopted++;
		if (this.watched && this.#framed === undefined) this.#framed = state.kind === "rows" ? state.value : NO_VALUE;
		if (run.kind === "rows") {
			this.#failing = false;
			this.#byKey = run.rows.byKey;
			this.#state = { kind: "rows", value: run.rows.value };
		} else {
			if (!this.#failing) this.#owner.report(handedOut(run.error));
			this.#failing = true;
			const last = state.kind === "rows" ? state.value : state.kind === "failed" ? state.last : undefined;
			this.#state = { kind: "failed", error: run.error, last };
		}
		this.changed();
	}

	/** Delivers the frame: the diff from the rows its watches had, or one failure call when they had rows. */
	deliver(context: Context): void {
		const before = this.#framed;
		this.#framed = undefined;
		const state = this.#state;
		if (state.kind === "rows") {
			// Listed by `adopt`, so `before` was kept (a detach in the batch leaves no rows).
			const after = state.value;
			const ops: readonly Op[] = before === NO_VALUE ? [["r", after]] : diffRevisions(before!, after);
			if (ops.length > 0) this.publish(after, ops, false, context);
			return;
		}
		// Still failed since the last call: nothing new for the watches.
		if (state.kind === "failed" && before !== NO_VALUE) this.failWatches(state.error, context);
	}

	/** Its attempt ended: no commit re-runs it, reads throw `error` (the object's), its watches end `ended`. */
	detach(error: Error): void {
		this.handle.owner.queries.delete(this);
		this.#state = { kind: "detached", error };
		this.#framed = undefined;
		this.endWatches();
	}

	/** One run, counted where it happens (the cost guard: a commit not writing the table runs none). */
	#count(context: Context): void {
		context.telemetry.metrics?.counter("chord.query.runs").add(1);
	}

	/**
	 * The rows of `stored`: a row whose stored columns are all the same as in the last adopted run is that run's object
	 * (one comparison per physical column), any other is decoded.
	 */
	#decode(stored: readonly StoredRow[], context: Context): Rows {
		const { key, rows } = this.handle.definition;
		const value: JsonValue[] = [];
		const byKey = new Map<unknown, Decoded>();
		for (const each of stored) {
			const id = key.length === 1 ? each[key[0]!] : JSON.stringify(key.map((column) => each[column]));
			const before = this.#byKey.get(id);
			const row =
				before !== undefined && sameStored(before.stored, each, rows.physical)
					? before.row
					: // A table's rows hold its columns' values: scalars and JSON.
						(rows.decode(each, context) as JsonValue);
			value.push(row);
			byKey.set(id, { stored: each, row });
		}
		return { value, byKey };
	}
}

/** Whether two stored rows have the same value in every physical column (SQLite values compare by `===`). */
function sameStored(a: StoredRow, b: StoredRow, physical: readonly string[]): boolean {
	for (const column of physical) if (a[column] !== b[column]) return false;
	return true;
}
