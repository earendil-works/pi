// The store's reads (slice 14 §3.2, §5): which reads read which table, whoever owns them, and which table each
// column set is bound to. A transaction that wrote tables stages `ReadRefresh`: inside its commit step, after its
// writes, it takes the reads its writes can concern from the index as it is then (the commit index, slice 15 §3),
// runs the skip test, runs the others again and adopts their results in the commit's batch.

import type { Context } from "../context/index.ts";
import { chordMetrics } from "../telemetry.ts";
import { existsIn, type WhereNode } from "./expression.ts";
import type { Query } from "./query.ts";
import type { Read, ReadRun } from "./read.ts";
import { ReadIndex } from "./read-index.ts";
import type { Bindings, Bound } from "./read-plan.ts";
import { type Change, type KeyedChange, skips } from "./skip.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { StoreWrite } from "./writes.ts";

/** An open query as the index retires it: who offers it, and its close. */
type Retirable = { readonly spec: { readonly owner: object }; close(): void };

/** A binding as the store keeps it: the table, and the object that owns it (which alone moves or drops it). */
type Binding = Bound & { readonly owner: object };

/**
 * The index from a table's SQL name to the reads over it, the bindings of column sets, and the tables that are not
 * ready (reads over them are held: not run, their rows kept). One per store.
 */
export class Reads implements Bindings {
	readonly #byTable = new Map<string, Set<Read>>();
	readonly #sets = new Map<string, Binding>();
	/** The names each owner has bound: an activation asks for its own without walking every binding. */
	readonly #bound = new Map<object, Set<string>>();
	/** The tables being migrated or not created yet; reads over them wait for `ready`. */
	readonly #held = new Set<string>();
	/** Who is told when a set's binding or its table's readiness changes, by set name. */
	readonly #watchers = new Map<string, Set<() => void>>();
	/** The open queries by who offers them (`QuerySpec.owner`): closed when that one retires. */
	readonly #offered = new Map<object, Set<Retirable>>();
	readonly #index = new ReadIndex();

	/** Enters `read` under every table it uses: every commit writing one of them it can concern tests it from now on. */
	add(read: Read): void {
		for (const { table } of read.plan.uses) {
			let reads = this.#byTable.get(table);
			if (reads === undefined) {
				reads = new Set();
				this.#byTable.set(table, reads);
			}
			reads.add(read);
		}
		this.#index.add(read);
	}

	/** Removes `read`: no commit runs it again. */
	delete(read: Read): void {
		for (const { table } of read.plan.uses) {
			const reads = this.#byTable.get(table);
			if (reads === undefined) continue;
			reads.delete(read);
			if (reads.size === 0) this.#byTable.delete(table);
		}
		this.#index.delete(read);
	}

	/**
	 * The reads a step's `changes` to `tables` can concern (slice 15 §3), each with the writes its skip test takes: an
	 * indexed read the writes it is a candidate of, any other every write. A bulk write concerns every read of its
	 * table.
	 */
	async candidates(
		tables: readonly string[],
		changes: readonly Change[],
		step: Step,
	): Promise<Map<Read, readonly Change[]>> {
		const chosen = new Map<Read, readonly Change[]>();
		const indexed = new Map<Read, KeyedChange[]>();
		for (const table of tables) {
			const reads = this.#byTable.get(table);
			if (reads === undefined) continue;
			const written = changes.filter((change) => change.table === table);
			const keyed = written.filter((change): change is KeyedChange => change.kind !== "bulk");
			const every =
				keyed.length === written.length ? await this.#index.candidates(table, keyed, step, indexed) : reads;
			for (const read of every) chosen.set(read, changes);
		}
		// A read unindexed on another written table is tested against every write already.
		for (const [read, its] of indexed) if (!chosen.has(read)) chosen.set(read, its);
		return chosen;
	}

	/** `query` is open: it closes when its owner retires. */
	opened(query: Retirable): void {
		const { owner } = query.spec;
		let queries = this.#offered.get(owner);
		if (queries === undefined) {
			queries = new Set();
			this.#offered.set(owner, queries);
		}
		queries.add(query);
	}

	/** `query` was closed. */
	closed(query: Retirable): void {
		const queries = this.#offered.get(query.spec.owner);
		if (queries === undefined) return;
		queries.delete(query);
		if (queries.size === 0) this.#offered.delete(query.spec.owner);
	}

	/**
	 * `owner` offers its queries no more (a provider's attempt ended; slice 14 §3.2): their reads leave the index, so
	 * no commit runs a statement compiled for its tables as they were. Their readers keep their last values and read
	 * the successor's queries when it is live.
	 */
	retire(owner: object): void {
		for (const query of [...(this.#offered.get(owner) ?? [])]) query.close();
	}

	/** The reads over `table`, if any. */
	on(table: string): ReadonlySet<Read> | undefined {
		return this.#byTable.get(table);
	}

	/** The reads over a table with a `host(...)` column of host kind `kind`: what a host data change runs again. */
	onHostKind(kind: string): Read[] {
		const found = new Set<Read>();
		for (const reads of this.#byTable.values()) {
			for (const read of reads) if (usesHostKind(read, kind, this)) found.add(read);
		}
		return [...found];
	}

	get(set: string): Bound | undefined {
		return this.#sets.get(set);
	}

	/**
	 * Binds `set` to `bound` for `owner` (its table declares `exposes`). A set bound by another owner to another table
	 * is refused (declaration policy: two tables exposing one name), naming both.
	 */
	bind(set: string, bound: Bound, owner: object): void {
		const current = this.#sets.get(set);
		if (current !== undefined && current.owner !== owner && current.table !== bound.table) {
			throw new Error(`column set "${set}" is exposed by tables "${current.table}" and "${bound.table}"`);
		}
		if (current?.table === bound.table && current.definition === bound.definition && current.owner === owner) return;
		if (current !== undefined) this.#bound.get(current.owner)?.delete(set);
		this.#sets.set(set, { ...bound, owner });
		let sets = this.#bound.get(owner);
		if (sets === undefined) {
			sets = new Set();
			this.#bound.set(owner, sets);
		}
		sets.add(set);
		this.#changed(set);
	}

	/** Drops `owner`'s binding of `set` (its new code exposes it no more, or it ended). */
	unbind(set: string, owner: object): void {
		if (this.#sets.get(set)?.owner !== owner) return;
		this.#sets.delete(set);
		const sets = this.#bound.get(owner);
		sets?.delete(set);
		if (sets?.size === 0) this.#bound.delete(owner);
		this.#changed(set);
	}

	/** The sets `owner` has bound. */
	boundBy(owner: object): string[] {
		return [...(this.#bound.get(owner) ?? [])];
	}

	/** Marks `table` not ready (its owner's successor creates or migrates it): reads over it are held. */
	hold(table: string): void {
		this.#held.add(table);
	}

	/** `table` is ready again: the reads over the sets bound to it compile and run once. */
	ready(table: string): void {
		if (!this.#held.delete(table)) return;
		for (const [set, binding] of this.#sets) if (binding.table === table) this.#changed(set);
	}

	/** Whether a read over `table` must wait. */
	isHeld(table: string): boolean {
		return this.#held.has(table);
	}

	/** Calls `changed` whenever `set`'s binding or its table's readiness changes, until the returned release. */
	watch(set: string, changed: () => void): () => void {
		let watchers = this.#watchers.get(set);
		if (watchers === undefined) {
			watchers = new Set();
			this.#watchers.set(set, watchers);
		}
		watchers.add(changed);
		return () => {
			const current = this.#watchers.get(set);
			if (current === undefined) return;
			current.delete(changed);
			if (current.size === 0) this.#watchers.delete(set);
		};
	}

	#changed(set: string): void {
		for (const changed of [...(this.#watchers.get(set) ?? [])]) changed();
	}
}

function usesHostKind(read: Read, kind: string, reads: Reads): boolean {
	const { query } = read.plan;
	if (query.table.hostColumn?.host.kind.kind === kind) return true;
	// A joined or `exists` table with a host column of the kind: found through the bindings of the sets it names.
	return read.plan.uses.some((use) => {
		if (use.role === "own") return false;
		for (const set of setsOf(query)) {
			const bound = reads.get(set);
			if (bound?.table === use.table && bound.definition.hostColumn?.host.kind.kind === kind) return true;
		}
		return false;
	});
}

/** The names of the column sets `query` reads besides its own table: the joined one and every `exists`'. */
export function setsOf(query: Query): ReadonlySet<string> {
	const sets = new Set<string>();
	if (query.joined !== undefined) sets.add(query.joined.set.name);
	const collect = (condition: WhereNode): void => {
		for (const [set, , inner] of existsIn(condition)) {
			sets.add(set);
			if (inner !== null) collect(inner);
		}
	};
	if (query.condition !== undefined) collect(query.condition);
	return sets;
}

const NO_WRITES: readonly StoreWrite[] = [];

/**
 * The refresh of a transaction's reads: `write` runs in the commit step after the commit's own writes (the last
 * write of the last phase) and chooses the reads there, from the index at that moment; `adopt` hands each run to its
 * read, inside the commit's batch. A refused step adopts nothing. A transaction stages it as its own change.
 */
export class ReadRefresh {
	readonly #reads: Reads;
	readonly #tables: readonly string[];
	readonly #changes: () => readonly Change[];
	readonly #context: Context;
	readonly #runs: { readonly read: Read; readonly run: ReadRun }[] = [];
	/** The staged write that reads; it writes nothing and records nothing in the outbox. */
	readonly write: StagedWrite;

	/**
	 * `tables` are the SQL names of the tables the transaction wrote; `changes` gives its writes, and is asked only
	 * when a read over one of them exists in the step.
	 */
	constructor(reads: Reads, tables: readonly string[], changes: () => readonly Change[], context: Context) {
		this.#reads = reads;
		this.#tables = tables;
		this.#changes = changes;
		this.#context = context;
		this.write = { order: "write", apply: (step) => this.#refresh(step) };
	}

	async #refresh(step: Step): Promise<readonly StoreWrite[]> {
		// A grouped commit that rolled back applies again alone (store.ts): only the last application's runs count.
		this.#runs.length = 0;
		if (this.#tables.every((table) => this.#reads.on(table) === undefined)) return NO_WRITES;
		const chosen = await this.#reads.candidates(this.#tables, this.#changes(), step);
		const metrics = chordMetrics(this.#context.telemetry.metrics);
		for (const [read, changes] of chosen) {
			// Held: a table it reads is being created or migrated; it runs once when the table is ready.
			if (read.plan.uses.some((use) => this.#reads.isHeld(use.table))) continue;
			if (await skips(read, changes, step, this.#context)) {
				metrics.counter("chord.query.skips").add(1);
				continue;
			}
			const run = await read.run(step, this.#context);
			read.ran(step.executor, run);
			this.#runs.push({ read, run });
		}
		return NO_WRITES;
	}

	/** Hands each run to its read, inside the commit's batch. */
	adopt(): void {
		for (const { read, run } of this.#runs) read.adopt(run);
	}

	committed(): void {}

	discarded(): void {}
}
