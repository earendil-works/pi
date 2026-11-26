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
	/** What a read keeps of the run once adopted. */
	readonly kept: KeptRows;
	/**
	 * The identity (`identity`) of each fetched row's key, in order, for a key of several columns: its JSON, made once
	 * per row for the read and for whoever decodes the rows (`DecodedRows`). `undefined` for a key of one column (the
	 * value itself: nothing to make).
	 */
	readonly ids: readonly unknown[] | undefined;
};

/**
 * What a read keeps of a run of rows for the skip test: not the rows (node:sqlite returns each as a dictionary-mode
 * object, 256 B for two columns; the read's owner keeps what it shows), only the keys, pairs and bound.
 */
export type KeptRows = {
	readonly kind: "rows";
	/** The own keys of the fetched rows, each as `identityOf` its key values. */
	readonly keys: ReadonlySet<unknown>;
	/** Per use of another table, the fetched rows' values of the own columns it pairs by, each as `identityOf` them. */
	readonly paired: ReadonlyMap<Use, ReadonlySet<unknown>>;
	/** The position of the row past `limit`, when there is one: the read's range ends there. */
	readonly past: Position | undefined;
};

/** What a read keeps of an adopted run: its rows' keys, or that it counted. */
export type Kept = KeptRows | { readonly kind: "count" };

/** What a count keeps: nothing but that it has a result. */
const COUNTED: Kept = { kind: "count" };

/** One run of a read: its result, the number of a count, or why it could not run. */
export type ReadRun =
	| { readonly kind: "rows"; readonly result: ReadResult }
	| { readonly kind: "count"; readonly count: number }
	| { readonly kind: "failed"; readonly error: unknown };

/** What a read runs its statements on: a commit step, or the backend under the store's guarded read. */
export type ReadExecutor = Pick<SqliteExecutor, "all" | "get">;

/** Who takes a read's runs: called inside the batch of the commit that ran it. */
export type ReadSink = { adopt(run: ReadRun): void };

/**
 * Who takes a registered read's runs: its open read, told which read ran (a run of an earlier registration is
 * dropped by it). One object for all its registrations, not a closure per registration (136 B).
 */
export type RunSink = { adopt(run: ReadRun, read: Read): void };

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
	/** Its open read, which takes its runs (`RunSink`); `sink` is the one-argument face of it. */
	readonly #open: RunSink;
	/** Which registration of its open read it is. */
	readonly registration: number;
	/** What it keeps of its last adopted run; `undefined` while loading or failed: such a read is never skipped. */
	#adopted: Kept | undefined;
	/** A step's run not adopted yet, with the backend transaction it ran in (a rolled-back group's is stale). */
	#tentative: { readonly transaction: SqliteExecutor; readonly run: ReadRun } | undefined;
	/** The commit index that files it by its kept keys, if one does. */
	#watcher: KeptKeysWatcher | undefined;

	constructor(plan: ReadPlan, what: ReadKind, sink: RunSink, registration: number) {
		this.plan = plan;
		this.what = what;
		this.#open = sink;
		this.registration = registration;
	}

	/**
	 * Takes `rows` as its adopted result without running: every row of its range, known to its owner already (a
	 * list's page cut from another one's rows). The sink is not told.
	 */
	know(rows: readonly StoredRead[]): void {
		// A count has no rows to know.
		const range = (this.what as Extract<ReadKind, { readonly kind: "rows" }>).range;
		this.#adopted = this.#result(rows, { ...range, limit: Math.max(range.limit, rows.length) }).kept;
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
		return tentative === undefined ? [adopted.keys] : [adopted.keys, tentative.result.kept.keys];
	}

	/**
	 * What the skip test of a step in `transaction` compares against: the group's latest run, else the adopted one;
	 * `undefined` while loading or failed.
	 */
	latest(transaction: SqliteExecutor): Kept | undefined {
		const tentative = this.#tentative;
		if (tentative?.transaction !== transaction) return this.#adopted;
		return keptOf(tentative.run);
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

	/**
	 * Who takes its runs, as a sink of one argument: what its open read does with a run of this read. Made when asked
	 * (an adapter of the store's reads; the store hands runs on directly), so no read keeps one.
	 */
	get sink(): ReadSink {
		return { adopt: (run) => this.#open.adopt(run, this) };
	}

	/** Takes `run` as its state and hands it to the sink. */
	adopt(run: ReadRun): void {
		if (this.#tentative?.run === run) this.#tentative = undefined;
		this.#adopted = keptOf(run);
		this.#watcher?.kept(this);
		this.#open.adopt(run, this);
	}

	/** The range its probe asks about: the read's own, ending at the row past its limit when there is one. */
	probed(kept: KeptRows): Range {
		// A count is never probed (slice 14 §3.3).
		const range = (this.what as Extract<ReadKind, { readonly kind: "rows" }>).range;
		return kept.past === undefined ? { ...range, limit: 1 } : { ...range, through: kept.past, limit: 1 };
	}

	#result(stored: readonly StoredRead[], range: Range): ReadResult {
		const { plan } = this;
		const keyColumns = plan.query.table.key;
		const keys = new Set<unknown>();
		const ids = keyColumns.length === 1 ? undefined : new Array<unknown>(stored.length);
		// Made by the first use that pairs: a read of its own table alone (most reads) shares the empty map.
		let paired: Map<Use, Set<unknown>> | undefined;
		for (const use of plan.uses) {
			if (use.role === "own" || use.pairs === undefined) continue;
			paired ??= new Map();
			paired.set(use, new Set());
		}
		for (let at = 0; at < stored.length; at++) {
			const row = stored[at]!;
			const id = identity(keyColumns, row);
			keys.add(id);
			if (ids !== undefined) ids[at] = id;
			if (paired !== undefined) for (const [use, values] of paired) values.add(identity(use.pairs!, row));
		}
		const more = stored.length > range.limit;
		const past = more ? plan.order.columns.map((name) => stored[range.limit]![name]!) : undefined;
		const kept: KeptRows = { kind: "rows", keys, paired: paired ?? NOTHING_PAIRED, past };
		return { rows: more ? stored.slice(0, range.limit) : stored, more, kept, ids };
	}
}

/** What a read keeps of `run`: `undefined` for a failed one. */
function keptOf(run: ReadRun): Kept | undefined {
	return run.kind === "rows" ? run.result.kept : run.kind === "count" ? COUNTED : undefined;
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
