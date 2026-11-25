// Reads (slice 14 §3.2, §3.3): one statement the store keeps current. A read is registered with the store under
// every table it uses; a commit that writes one of them runs the skip test and, unless it skips, runs the read again
// in its step. What a read does with its rows is its sink's business (a live query's rows, a list's page, a count).

import type { Context } from "../context/index.ts";
import type { SqliteExecutor, SqliteValue } from "../sqlite/index.ts";
import { chordMetrics } from "../telemetry.ts";
import type { Position, Range, ReadPlan, StoredRead, Use } from "./read-plan.ts";

/**
 * The rows of one run, at most the range's `limit`; `more` says a further row followed inside the range. The keys
 * are of every row fetched, the one past `limit` included (slice 14 §3.3).
 */
export type ReadResult = {
	readonly rows: readonly StoredRead[];
	readonly more: boolean;
	/** The own keys of the fetched rows, each as `identityOf` its key values. */
	readonly keys: ReadonlySet<unknown>;
	/** Per use of another table, the fetched rows' values of the own columns it pairs by, each as `identityOf` them. */
	readonly paired: ReadonlyMap<Use, ReadonlySet<unknown>>;
	/** The position of the row past `limit`, when there is one: the read's range ends there. */
	readonly past: Position | undefined;
};

/** One run of a read: its result, the number of a count, or why it could not run. */
export type ReadRun =
	| { readonly kind: "rows"; readonly result: ReadResult }
	| { readonly kind: "count"; readonly count: number }
	| { readonly kind: "failed"; readonly error: unknown };

/** What a read runs its statements on: a commit step, or the backend under the store's guarded read. */
export type ReadExecutor = Pick<SqliteExecutor, "all" | "get">;

/** Who takes a read's runs: called inside the batch of the commit that ran it. */
export type ReadSink = { adopt(run: ReadRun): void };

/** Who is told when the keys a read keeps change: the commit index it is filed in (slice 15 §3). */
export type KeptKeysWatcher = { kept(read: Read): void };

/** What a read is: the rows of a range, or the number of rows of its condition. */
export type ReadKind = { readonly kind: "rows"; readonly range: Range } | { readonly kind: "count" };

/**
 * A read registered with the store. It keeps what the skip test needs of its last adopted run, and of a run a
 * commit group has not adopted yet (`tentative`: a later step of the group tests against it).
 */
export class Read {
	readonly plan: ReadPlan;
	readonly what: ReadKind;
	readonly sink: ReadSink;
	/** The last adopted run; `undefined` while loading or failed: such a read is never skipped. */
	#adopted: ReadRun | undefined;
	/** A step's run not adopted yet, with the backend transaction it ran in (a rolled-back group's is stale). */
	#tentative: { readonly transaction: SqliteExecutor; readonly run: ReadRun } | undefined;
	/** The commit index that files it by its kept keys, if one does. */
	#watcher: KeptKeysWatcher | undefined;

	constructor(plan: ReadPlan, what: ReadKind, sink: ReadSink) {
		this.plan = plan;
		this.what = what;
		this.sink = sink;
	}

	/**
	 * Takes `rows` as its adopted result without running: every row of its range, known to its owner already (a
	 * list's page cut from another one's rows). The sink is not told.
	 */
	know(rows: readonly StoredRead[]): void {
		// A count has no rows to know.
		const range = (this.what as Extract<ReadKind, { readonly kind: "rows" }>).range;
		this.#adopted = {
			kind: "rows",
			result: this.#result(rows, { ...range, limit: Math.max(range.limit, rows.length) }),
		};
		this.#watcher?.kept(this);
	}

	/** Drops its adopted result: without one it is never skipped, so the next commit over its tables runs it. */
	forget(): void {
		this.#adopted = undefined;
		this.#watcher?.kept(this);
	}

	/** Tells `watcher` from now on whenever `kept` changes. */
	watchKept(watcher: KeptKeysWatcher | undefined): void {
		this.#watcher = watcher;
	}

	/**
	 * The keys of the rows a skip test of this read may compare against: its adopted run's, and a group's run not
	 * adopted yet; `undefined` while some such run is no rows (loading, failed, a count): then no write can be ruled out.
	 */
	kept(): readonly ReadonlySet<unknown>[] | undefined {
		const adopted = this.#adopted;
		const tentative = this.#tentative?.run;
		if (adopted?.kind !== "rows" || (tentative !== undefined && tentative.kind !== "rows")) return undefined;
		return tentative === undefined ? [adopted.result.keys] : [adopted.result.keys, tentative.result.keys];
	}

	/** The run the skip test of a step in `transaction` compares against: the group's latest, else the adopted one. */
	latest(transaction: SqliteExecutor): ReadRun | undefined {
		return this.#tentative?.transaction === transaction ? this.#tentative.run : this.#adopted;
	}

	/** Runs the read inside a commit step, after its writes: the run, or the failure; it never throws. */
	async run(step: ReadExecutor, context: Context): Promise<ReadRun> {
		try {
			return await this.fetch(step, context);
		} catch (error) {
			return { kind: "failed", error };
		}
	}

	/** One run on `reader`, counted where it happens; a backend error throws (the store's guarded read takes it). */
	async fetch(reader: ReadExecutor, context: Context): Promise<ReadRun> {
		const metrics = chordMetrics(context.telemetry.metrics);
		metrics.counter("chord.query.runs").add(1);
		const what = this.what;
		if (what.kind === "count") {
			const { sql, params } = this.plan.count();
			const row = await reader.get<{ readonly count: number }>(sql, ...params);
			return { kind: "count", count: row?.count ?? 0 };
		}
		// One row more than asked for: whether a further row exists, and where the range ends.
		const { sql, params } = this.plan.select({ ...what.range, limit: what.range.limit + 1 });
		const stored = await reader.all<StoredRead>(sql, ...params);
		metrics.counter("chord.query.rows").add(stored.length);
		return { kind: "rows", result: this.#result(stored, what.range) };
	}

	/** A step's run, kept for the later steps of its group until it is adopted. */
	ran(transaction: SqliteExecutor, run: ReadRun): void {
		this.#tentative = { transaction, run };
		this.#watcher?.kept(this);
	}

	/** Takes `run` as its state and hands it to the sink. */
	adopt(run: ReadRun): void {
		if (this.#tentative?.run === run) this.#tentative = undefined;
		this.#adopted = run.kind === "failed" ? undefined : run;
		this.#watcher?.kept(this);
		this.sink.adopt(run);
	}

	/** The range its probe asks about: the read's own, ending at the row past its limit when there is one. */
	probed(result: ReadResult): Range {
		// A count is never probed (slice 14 §3.3).
		const range = (this.what as Extract<ReadKind, { readonly kind: "rows" }>).range;
		return result.past === undefined ? { ...range, limit: 1 } : { ...range, through: result.past, limit: 1 };
	}

	#result(stored: readonly StoredRead[], range: Range): ReadResult {
		const { plan } = this;
		const keyColumns = plan.query.table.key;
		const keys = new Set<unknown>();
		// Made by the first use that pairs: a read of its own table alone (most reads) shares the empty map.
		let paired: Map<Use, Set<unknown>> | undefined;
		for (const use of plan.uses) {
			if (use.role === "own" || use.pairs === undefined) continue;
			paired ??= new Map();
			paired.set(use, new Set());
		}
		for (const row of stored) {
			keys.add(identity(keyColumns, row));
			if (paired !== undefined) for (const [use, values] of paired) values.add(identity(use.pairs!, row));
		}
		const more = stored.length > range.limit;
		const past = more ? plan.order.columns.map((name) => stored[range.limit]![name]!) : undefined;
		return { rows: more ? stored.slice(0, range.limit) : stored, more, keys, paired: paired ?? NOTHING_PAIRED, past };
	}
}

/** No use pairs with another table: the shared empty map. */
const NOTHING_PAIRED: ReadonlyMap<Use, ReadonlySet<unknown>> = new Map();

/**
 * The identity of `row` in `columns`, for a set or a map of rows of one read: the value itself for one column (most
 * keys: no text is built per row), `identityOf` the values for several.
 */
export function identity(
	columns: readonly string[],
	row: { readonly [column: string]: SqliteValue | undefined },
): unknown {
	return columns.length === 1 ? row[columns[0]!] : JSON.stringify(columns.map((name) => row[name]));
}

/** The identity of `values`, as `identity` gives it for a row holding them. */
export function identityOf(values: readonly SqliteValue[]): unknown {
	return values.length === 1 ? values[0] : JSON.stringify(values);
}
