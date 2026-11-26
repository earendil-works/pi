// Live queries (decision "Live queries over an object's own tables"; slice 14 §3): the rows of a query as a JSON
// watchable, kept current by the store's reads. `self.query(table, q, limit)` is the owner's own unnamed window (its
// value the rows); `self.liveQuery(namedQuery, args, { first })` reads a named query (its value `{ rows, more }`).
// Both are this source over one open read; a commit's run is published in that commit's batch as the diff from the
// previous rows (W1).

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { type FramedOwner, FramedSource } from "../state/internal.ts";
import { OpenQuery, type OpenRead, type QuerySpec, type ReadSite } from "./open-query.ts";
import type { Query } from "./query.ts";
import type { ReadResult, ReadRun, ReadSink } from "./read.ts";
import type { Range, StoredRead } from "./read-plan.ts";
import type { TableDefinition } from "./table.ts";
import { getRow, setRow, type TupleMap } from "./tuples.ts";

/**
 * What a live source reads: a query to keep open, and how a stored row of it becomes the value's row (decoded,
 * projected, mapped); a row the code cannot read throws.
 */
export type LiveTarget = {
	readonly spec: QuerySpec;
	decode(stored: StoredRead, context: Context): JsonValue;
};

/** What a live query reads and shows: the rows of `range` (as they are, or as `{ rows, more }`), or a count. */
export type LiveShape =
	| { readonly kind: "rows"; readonly range: Range; present(rows: JsonValue[], more: boolean): JsonValue }
	| { readonly kind: "count" };

/**
 * Refuses what the types cannot (plugin code is bundled without type checks; declaration policy): a query of another
 * table than `table`, and a `limit` that is no positive integer (a live query must be bounded: one run reads at most
 * `limit` rows).
 */
export function checkLiveQuery(table: TableDefinition, q: Query, limit: unknown, label: string): void {
	if (q.table !== table) {
		throw invalid("args", `${label}: self.query: a query of table "${q.table.name}" over "${table.name}"`);
	}
	if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
		throw invalid("args", `${label}: self.query: a limit is required, a positive integer`);
	}
}

/**
 * A live query as a JSON source (a state member, a derive source, an `on` source): the rows of one range of a query,
 * or its count. `read` gives it the query; a later `read` (arguments that follow a value, a provider's successor)
 * shows the previous value until the new read's first run is adopted, then switches in one frame.
 */
export class LiveQuery extends FramedSource {
	readonly #site: ReadSite;
	readonly #shape: LiveShape;
	readonly #rows = new DecodedRows("values");
	/** The read its value is of, and the one that replaces it once its first run is adopted. */
	#current: Reading | undefined;
	#next: Reading | undefined;

	constructor(site: ReadSite, owner: FramedOwner, shape: LiveShape) {
		super(site.batch, owner);
		this.#site = site;
		this.#shape = shape;
	}

	/**
	 * The first run of the owner's own window, before its object goes live (activation, after its tables are
	 * prepared): a failure throws and fails the activation, which reports it.
	 */
	async load(target: LiveTarget, context: Context): Promise<void> {
		this.quiet();
		await this.read(target, context);
		const failure = this.failure;
		if (failure !== undefined) throw failure.error;
	}

	/**
	 * Reads `target` from now on (its shape's range of it, or its count). Resolves with its first run once adopted
	 * (`undefined`: a commit's run came first, a table it reads is held, or the query was detached or given another
	 * read meanwhile).
	 */
	read(target: LiveTarget, context: Context): Promise<ReadRun | undefined> {
		if (this.detached) return Promise.resolve(undefined);
		this.#next?.query.close();
		const reading = new Reading(this, this.#site, this.#shape, target, context);
		this.#next = reading;
		return reading.read.load();
	}

	/**
	 * What it should read cannot be read (its arguments threw, its provider refused them): a failed member, as a
	 * failed run makes it. Its reads close: neither the read of the previous arguments nor a pending one may publish
	 * or heal the failure; the next `read` does.
	 */
	fail(error: unknown, context: Context): void {
		if (this.detached) return;
		this.#close();
		this.batch.within(() => this.failWith(error), context);
	}

	/** Its attempt ended: no commit runs it again, reads throw `error` (the object's), its watches end `ended`. */
	detach(error: Error): void {
		this.#close();
		this.end(error);
	}

	#close(): void {
		this.#current?.query.close();
		this.#next?.query.close();
		this.#current = undefined;
		this.#next = undefined;
	}

	/**
	 * Takes a run of one of its reads, inside a batch (called by the reading). The first run of a new read makes it the
	 * current one. A failed run, and a row the code cannot read, make the query a failed member.
	 */
	adopted(reading: Reading, run: ReadRun): void {
		if (this.detached) return;
		if (reading === this.#next) {
			this.#current?.query.close();
			this.#current = reading;
			this.#next = undefined;
			this.#rows.reset();
		} else if (reading !== this.#current) return;
		if (run.kind === "failed") this.failWith(run.error);
		else if (run.kind === "count") this.set(run.count);
		else this.#present(reading, run.result);
	}

	/** The value of a run's rows; a row the code cannot read fails the member. */
	#present(reading: Reading, result: ReadResult): void {
		const shape = this.#shape;
		// A count's read returns counts.
		if (shape.kind !== "rows") return;
		try {
			this.set(shape.present(this.#rows.decode(result.rows, reading.target, reading.query.context), result.more));
		} catch (error) {
			this.failWith(error);
		}
	}
}

/**
 * One of a live query's reads, open, with the query it is of and what it reads; the sink of its runs. A class: an
 * object and a closure as its sink cost 88 B per read.
 */
class Reading implements ReadSink {
	readonly query: OpenQuery;
	readonly target: LiveTarget;
	readonly read: OpenRead;
	readonly #live: LiveQuery;

	constructor(live: LiveQuery, site: ReadSite, shape: LiveShape, target: LiveTarget, context: Context) {
		this.#live = live;
		this.target = target;
		// A binding changed: its one read runs again (a failure is a failed run handed to it; nothing awaits the run).
		this.query = new OpenQuery(site, target.spec, shape.kind, () => void this.read.load(), context);
		// A shape of rows is what the read reads (its range), a count is one: no read kind made per read.
		this.read = this.query.read(shape, this);
	}

	adopt(run: ReadRun): void {
		this.#live.adopted(this, run);
	}
}

/**
 * A row as a run decoded it, with the values of the stored row it came from in `columns`, that row's columns in its
 * own order. Not the stored row itself: node:sqlite returns a dictionary-mode object per row (256 B for two columns),
 * and a value keeps every row it shows.
 */
class Decoded {
	readonly columns: readonly string[];
	readonly values: readonly SqliteValue[];
	readonly row: JsonValue;

	constructor(columns: readonly string[], values: readonly SqliteValue[], row: JsonValue) {
		this.columns = columns;
		this.values = values;
		this.row = row;
	}
}

/**
 * A row as a run decoded it, with the stored row it came from: what decoded rows keep where the stored row is kept by
 * someone else anyway (a list's pages keep theirs), so it costs nothing more than the entry.
 */
class KeptRow {
	readonly stored: StoredRead;
	readonly row: JsonValue;

	constructor(stored: StoredRead, row: JsonValue) {
		this.stored = stored;
		this.row = row;
	}
}

/** An entry of decoded rows: the stored row's values, or the stored row (`DecodedRows`' `keeps`). */
type Entry = Decoded | KeptRow;

/** No rows decoded yet: the shared empty map. */
const NO_ROWS: TupleMap<Entry> = new Map();

const NO_COLUMNS: readonly string[] = [];

/**
 * The decoded rows of a live source's last value, by key: a row whose stored columns are all the same in the next
 * run is that value's object (one comparison per selected column), any other is decoded. So a frame, the diff from
 * the value the watches had, compares unchanged rows by identity (a window shifted by one row: one insert and one
 * removal, not a comparison of every row with every other).
 */
export class DecodedRows {
	/**
	 * What it keeps of a stored row to compare the next run's with: its values (a live query: nobody else keeps the
	 * row, a dictionary-mode object of node:sqlite's), or the row itself (a list: its pages keep their rows).
	 */
	readonly #keeps: "values" | "rows";
	/** By key, as tuples of the key's values; the one entry itself after a run of one row (a map of one costs 184 B). */
	#byKey: TupleMap<Entry> | Entry = NO_ROWS;
	/** The columns of the row decoded last: rows of one statement share them, so their entries share the list. */
	#columns: readonly string[] = NO_COLUMNS;

	/** `keeps` the values of a stored row (a live query's), or the row itself (a list's, by default). */
	constructor(keeps: "values" | "rows" = "rows") {
		this.#keeps = keeps;
	}

	/** The rows of `stored` as `target` decodes them, unchanged ones reused; a row the code cannot read throws. */
	decode(stored: readonly StoredRead[], target: LiveTarget, context: Context): JsonValue[] {
		const key = target.spec.query.table.key;
		if (stored.length === 1) {
			const one = this.#reused(key, stored[0]!, target, context);
			this.#byKey = one;
			return [one.row];
		}
		const byKey: TupleMap<Entry> = new Map();
		// `map`: a list of exactly its rows (the value keeps it; one pushed to reserves room for 16 more).
		const rows = stored.map((each) => {
			const decoded = this.#reused(key, each, target, context);
			setRow(byKey, key, each, decoded);
			return decoded.row;
		});
		this.#byKey = byKey;
		return rows;
	}

	/** Forgets the last value's rows: another target decodes its own way, nothing of the previous one is reused. */
	reset(): void {
		this.#byKey = NO_ROWS;
	}

	/**
	 * The entry of `stored`: the last value's row of its key when its stored columns are all the same, else decoded.
	 * Kept values stay the entry as it is; a kept row is replaced by the new one, which the next run is compared with.
	 */
	#reused(key: readonly string[], stored: StoredRead, target: LiveTarget, context: Context): Entry {
		const before = this.#byKey;
		const entry =
			before instanceof Map ? getRow(before, key, stored) : holdsKey(before, key, stored) ? before : undefined;
		if (entry instanceof KeptRow) {
			return new KeptRow(stored, sameRow(entry.stored, stored) ? entry.row : target.decode(stored, context));
		}
		if (entry !== undefined && sameStored(entry, stored)) return entry;
		if (this.#keeps === "rows") return new KeptRow(stored, target.decode(stored, context));
		return this.#decoded(stored, target, context);
	}

	#decoded(stored: StoredRead, target: LiveTarget, context: Context): Decoded {
		const row = target.decode(stored, context);
		const columns = this.#columnsOf(stored);
		return new Decoded(
			columns,
			columns.map((column) => stored[column]!),
			row,
		);
	}

	/**
	 * The columns of `stored` as `for…in` enumerates them (its own and inherited enumerable ones, as the comparison of
	 * two stored rows did): the list of the row decoded last when it has the same.
	 */
	#columnsOf(stored: StoredRead): readonly string[] {
		const last = this.#columns;
		let at = 0;
		let same = true;
		for (const column in stored) {
			if (last[at] !== column) same = false;
			at++;
		}
		if (same && at === last.length) return last;
		// Of exactly its length: a list pushed to reserves room for 16 more (152 B for two columns).
		const columns = new Array<string>(at);
		at = 0;
		for (const column in stored) columns[at++] = column;
		this.#columns = columns;
		return columns;
	}
}

/** Whether `entry` came from a row of `stored`'s key: its values in the key columns are `stored`'s (as a map keys). */
function holdsKey(entry: Entry, key: readonly string[], stored: StoredRead): boolean {
	for (let index = 0; index < key.length; index++) {
		let a: unknown;
		if (entry instanceof KeptRow) a = entry.stored[key[index]!];
		else {
			const at = entry.columns.indexOf(key[index]!);
			if (at < 0) return false;
			a = entry.values[at];
		}
		const b = stored[key[index]!];
		// SameValueZero, as a map's keys: `NaN` is `NaN`.
		// biome-ignore lint/suspicious/noSelfCompare: NaN is the one value unequal to itself.
		if (!(a === b || (a !== a && b !== b))) return false;
	}
	return true;
}

/**
 * Whether `stored` has the decoded row's values in every column of the row it came from (SQLite values compare by
 * `===`): what comparing the two stored rows column by column gave, without keeping the old one.
 */
function sameStored(decoded: Decoded, stored: StoredRead): boolean {
	const { columns, values } = decoded;
	for (let at = 0; at < columns.length; at++) if (stored[columns[at]!] !== values[at]) return false;
	return true;
}

/** Whether two stored rows of one statement have the same value in every column (SQLite values compare by `===`). */
function sameRow(a: StoredRead, b: StoredRead): boolean {
	for (const column in a) if (a[column] !== b[column]) return false;
	return true;
}
