// Decoded rows: the rows a live source showed last, by key, so that the next run's rows whose stored columns are all
// the same are the same objects, and a frame compares unchanged rows by identity. A live query's shared read keeps one
// (`shared-read.ts`), a list another (`host/list.ts`).

import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { LiveTarget } from "./live-query.ts";
import { identity } from "./read.ts";
import type { StoredRead } from "./read-plan.ts";

/** No rows decoded yet: the shared empty map. */
const NO_ROWS: ReadonlyMap<unknown, Entry> = new Map();

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
	/** By key (`identity`); the one entry itself after a run of one row (a map of one costs 184 B), its key `#oneId`. */
	#byKey: ReadonlyMap<unknown, Entry> | Entry = NO_ROWS;
	#oneId: unknown;
	/** The columns of the rows decoded since the last reset: their entries share the list. */
	#columns: readonly string[] | undefined;

	/** `keeps` the values of a stored row (a live query's), or the row itself (a list's, by default). */
	constructor(keeps: "values" | "rows" = "rows") {
		this.#keeps = keeps;
	}

	/**
	 * The rows of `stored` as `target` decodes them, unchanged ones reused; a row the code cannot read throws. `ids`:
	 * the identities of their keys when the run that fetched them made them already (`ReadResult.ids`).
	 */
	decode(stored: readonly StoredRead[], target: LiveTarget, context: Context, ids?: readonly unknown[]): JsonValue[] {
		const key = target.spec.query.table.key;
		if (stored.length === 1) {
			const one = stored[0]!;
			const id = ids === undefined ? identity(key, one) : ids[0];
			const entry = this.#reused(id, one, target, context);
			this.#byKey = entry;
			this.#oneId = id;
			return [entry.row];
		}
		const byKey = new Map<unknown, Entry>();
		// `map`: a list of exactly its rows (the value keeps it; one pushed to reserves room for 16 more).
		const rows = stored.map((each, at) => {
			const id = ids === undefined ? identity(key, each) : ids[at];
			const decoded = this.#reused(id, each, target, context);
			byKey.set(id, decoded);
			return decoded.row;
		});
		this.#byKey = byKey;
		this.#oneId = undefined;
		return rows;
	}

	/** Forgets the last value's rows: another target decodes its own way, nothing of the previous one is reused. */
	reset(): void {
		this.#byKey = NO_ROWS;
		this.#oneId = undefined;
		this.#columns = undefined;
	}

	/**
	 * The entry of `stored`: the last value's row of its key when its stored columns are all the same, else decoded.
	 * Kept values stay the entry as it is; a kept row is replaced by the new one, which the next run is compared with.
	 */
	#reused(id: unknown, stored: StoredRead, target: LiveTarget, context: Context): Entry {
		const before = this.#byKey;
		const entry = before instanceof Map ? before.get(id) : this.#oneId === id ? (before as Entry) : undefined;
		if (entry instanceof KeptRow) {
			// The same stored row (a list's page that did not run again hands its rows again): unchanged, a row being
			// plain data the backend does not change (`sqliteBackend`); no comparison of its columns (1,000 loaded rows
			// per frame of a list).
			if (entry.stored === stored) return entry;
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
	 * The columns of the stored rows: one list for every row decoded since the last reset, taken from the first, as
	 * the rows of one statement have the same columns (the backend contract, `sqliteBackend`).
	 */
	#columnsOf(stored: StoredRead): readonly string[] {
		this.#columns ??= Object.keys(stored);
		return this.#columns;
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
