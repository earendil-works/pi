// Open queries (slice 14 §3.2, §5): a query kept compiled against the store's bindings for as long as someone reads
// it, and the reads of it, one per range (a live query has one, a list one per page). The query compiles once into a
// plan; when a column set it names is bound, moved, dropped or its table becomes ready after a migration, it compiles
// again, its reads are registered for the new plan and its owner is told, which reads again (one read alone; a list
// every page as one new tiling: rows and order may be others everywhere). A query that cannot be compiled (a set nobody serves, a column that is not what it
// was written for) is a failed run of each read, not a throw.

import type { Context } from "../context/index.ts";
import type { Batch } from "../state/internal.ts";
import type { Query } from "./query.ts";
import { Read, type ReadKind, type ReadRun, type ReadSink, type RunSink } from "./read.ts";
import { type Projection, type Range, ReadPlan, type ShapeSlot, type StoredRead } from "./read-plan.ts";
import { setsOf } from "./reads.ts";
import type { ChordStore } from "./store.ts";

/** What an open query reads: a query of the table named `table`, and the columns its mapping gets. */
export type QuerySpec = {
	readonly query: Query;
	/** The own table's SQL name. */
	readonly table: string;
	readonly projection: Projection;
	/** Who offers the query (the attempt's table handle): when it retires, the query's reads leave the index. */
	readonly owner: object;
	/** Where the plans of its named query share their shape; none for a window of the owner's own (`self.query`). */
	readonly shapes?: ShapeSlot;
};

/** Where an open query lives: the store whose index its reads are in, and the batch adoptions outside a commit run in. */
export type ReadSite = { readonly store: ChordStore; readonly batch: Batch };

/** A query's plan for the bindings as they are, or why it does not compile. */
type Compiled =
	| { readonly kind: "compiled"; readonly plan: ReadPlan }
	| { readonly kind: "failed"; readonly error: unknown };

const NO_WATCHES: (() => void)[] = [];
const NO_READS: readonly OpenRead[] = [];

/** A query compiled for the bindings as they are, with its open reads. */
export class OpenQuery {
	readonly spec: QuerySpec;
	readonly site: ReadSite;
	/** The context its reads run and recompile under. */
	readonly context: Context;
	readonly #shape: "rows" | "count";
	readonly #rebound: () => void;
	/**
	 * Its open reads: without a set while there is at most one (a live query's one read; a set of one costs 152 B),
	 * in a set from the second on (a list's pages), kept once made.
	 */
	#read: OpenRead | undefined;
	#reads: Set<OpenRead> | undefined;
	/** The releases of its binding watches; `undefined` once closed. */
	#watches: (() => void)[] | undefined;
	#compiled: Compiled;

	/**
	 * `rebound` is called whenever a binding changed and the query was compiled again: its reads are registered for
	 * the new plan and none has a result (a commit over their tables runs them); its owner reads again.
	 */
	constructor(site: ReadSite, spec: QuerySpec, shape: "rows" | "count", rebound: () => void, context: Context) {
		this.site = site;
		this.spec = spec;
		this.context = context;
		this.#shape = shape;
		this.#rebound = rebound;
		const reads = site.store.reads;
		const sets = setsOf(spec.query);
		// No set besides its own table (most queries): the shared empty list, none made per query.
		this.#watches = sets.size === 0 ? NO_WATCHES : [...sets].map((set) => reads.watch(set, () => this.#recompile()));
		reads.opened(this);
		this.#compiled = this.#compile();
	}

	/** The plan while the query compiles, else why it does not. */
	get compiled(): Compiled {
		return this.#compiled;
	}

	/** Whether it was closed (by its reader, or because its owner retired). */
	get closed(): boolean {
		return this.#watches === undefined;
	}

	/**
	 * A read of `what`, registered now (a commit in between runs it); `load` runs it the first time. A read of a
	 * closed query is closed: it is never registered and never runs (a list whose provider retired cuts and loads
	 * pages of runs still in flight; no statement of the old plan may enter the index again).
	 */
	read(what: ReadKind, sink: ReadSink): OpenRead {
		const read = new OpenRead(this, what, sink);
		if (this.closed) return read;
		if (this.#reads !== undefined) this.#reads.add(read);
		else if (this.#read === undefined) this.#read = read;
		else {
			this.#reads = new Set([this.#read, read]);
			this.#read = undefined;
		}
		return read;
	}

	/**
	 * A read of `range` whose rows are known already: every row of the range, as another read of this query returned
	 * them (a list's page cut from, or merged of, other pages). Nothing is read and its sink is not told.
	 */
	readKnown(range: Range, rows: readonly StoredRead[], sink: ReadSink): OpenRead {
		const read = this.read({ kind: "rows", range }, sink);
		read.know(rows);
		return read;
	}

	/** `read` was closed: the query keeps nothing of it. */
	forget(read: OpenRead): void {
		if (this.#reads !== undefined) this.#reads.delete(read);
		else if (this.#read === read) this.#read = undefined;
	}

	/** Its reads leave the index and it stops following bindings: no commit runs them again. */
	close(): void {
		if (this.#watches === undefined) return;
		for (const release of this.#watches) release();
		this.#watches = undefined;
		this.site.store.reads.closed(this);
		for (const read of this.#opened()) read.close();
	}

	/** Its open reads now, in the order they were opened: a copy, which what is done with them may change. */
	#opened(): readonly OpenRead[] {
		if (this.#reads !== undefined) return [...this.#reads];
		return this.#read === undefined ? NO_READS : [this.#read];
	}

	#compile(): Compiled {
		const { query, table, projection, shapes } = this.spec;
		try {
			const plan = new ReadPlan(query, table, projection, this.#shape, this.site.store.reads, shapes);
			return { kind: "compiled", plan };
		} catch (error) {
			return { kind: "failed", error };
		}
	}

	/** A binding changed: the query is compiled for the tables as they are now, and its owner reads again. */
	#recompile(): void {
		if (this.#watches === undefined) return;
		this.#compiled = this.#compile();
		for (const read of this.#opened()) read.register();
		this.#rebound();
	}
}

/** One read of an open query: registered with the store while the query compiles. */
export class OpenRead implements RunSink {
	readonly what: ReadKind;
	readonly #query: OpenQuery;
	readonly #sink: ReadSink;
	#read: Read | undefined;
	#closed: boolean;
	/** Counts its adoptions and registrations: a first run that either overtook is dropped. */
	#generation = 0;
	/**
	 * Counts its registrations: a run belongs to the registration that computed it. A commit's step may have run the
	 * read before a binding changed; that run is of a plan the query no longer has and is dropped when the commit
	 * adopts it. Closing registers nothing, so a run a commit made before the close still reaches the sink.
	 */
	#registration = 0;

	constructor(query: OpenQuery, what: ReadKind, sink: ReadSink) {
		this.#query = query;
		this.what = what;
		this.#sink = sink;
		this.#closed = query.closed;
		this.register();
	}

	/** The registered read, while the query compiles and this read is open. */
	get read(): Read | undefined {
		return this.#read;
	}

	/**
	 * Enters a read of the query's current plan into the index (the previous one leaves it). Entered before its first
	 * run: a commit in between runs it (a read without a result is never skipped).
	 */
	register(): void {
		const reads = this.#query.site.store.reads;
		if (this.#read !== undefined) reads.delete(this.#read);
		this.#read = undefined;
		this.#generation++;
		const compiled = this.#query.compiled;
		if (this.#closed) return;
		const registration = ++this.#registration;
		if (compiled.kind === "failed") return;
		this.#read = new Read(compiled.plan, this.what, this, registration);
		reads.add(this.#read);
	}

	/** A run of one of its reads, inside a batch: handed to its sink unless an earlier registration made it. */
	adopt(run: ReadRun, read: Read): void {
		if (read.registration !== this.#registration) return;
		this.#generation++;
		this.#sink.adopt(run);
	}

	/**
	 * Takes `rows` as its adopted result without running: every row of its range, known to its owner (a page whose
	 * rows a run of another range of the query just changed). Its sink is not told.
	 */
	know(rows: readonly StoredRead[]): void {
		this.#read?.know(rows);
	}

	/** Its result is unknown from now on: the next commit over its tables runs it, whatever it writes. */
	forget(): void {
		this.#read?.forget();
	}

	/**
	 * Runs it once, outside the commit queue, and adopts the run in a batch; resolves with that run, `undefined` when
	 * a commit's run overtook it, a table it reads is held (it runs when the table is ready), or it was closed. Nothing
	 * throws: a query that does not compile and a run that fails are failed runs.
	 */
	async load(): Promise<ReadRun | undefined> {
		const { site, context, compiled } = this.#query;
		if (this.#closed) return undefined;
		if (compiled.kind === "failed") {
			const failed: ReadRun = { kind: "failed", error: compiled.error };
			site.batch.within(() => this.#sink.adopt(failed), context);
			return failed;
		}
		const read = this.#read!;
		if (read.plan.uses.some((use) => site.store.reads.isHeld(use.table))) return undefined;
		const generation = this.#generation;
		const run = await site.store
			.read((executor) => read.fetch(executor, context), context)
			.catch((error: unknown): ReadRun => ({ kind: "failed", error }));
		if (this.#generation !== generation) return undefined;
		site.batch.within(() => read.adopt(run), context);
		return run;
	}

	/** Leaves the index: no commit runs it again. A run a commit made already still reaches its sink. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#generation++;
		if (this.#read !== undefined) this.#query.site.store.reads.delete(this.#read);
		this.#read = undefined;
		this.#query.forget(this);
	}
}
