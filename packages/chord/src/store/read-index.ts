// The commit index of a store's reads (slice 15 §3): which reads a commit's keyed writes to a table can concern, so
// the commit step skip-tests those alone. A read whose condition fixes own columns with `eq` or `inArray` is filed
// under their values (its bucket) and the keys of its last result's rows; any other is unindexed. A write's
// candidates: the reads holding its key (the row was in their result), those whose bucket the row after the write
// matches (it may be now) and the unindexed ones. A pure speedup: a read that neither held the row nor can hold it
// after is one the skip test would skip.

import type { SqliteValue } from "../sqlite/index.ts";
import type { KeptKeysWatcher, Read } from "./read.ts";
import type { KeyedChange } from "./skip.ts";
import { quote } from "./sql.ts";
import type { Step } from "./step.ts";
import {
	deleteTuple,
	eachTuple,
	getRow,
	getTuple,
	hasTuple,
	setRow,
	setTuple,
	type TupleMap,
	type TupleSet,
} from "./tuples.ts";

/**
 * The reads filed under one value: the read itself while it is the only one, a set of them from the second on. Most
 * values are filed by one read (a session's bucket, its rows' keys), and a set of one costs 152 B: a read of 100 rows
 * filed by its kept keys made 100 of them at each run.
 */
type Filed = Read | Set<Read>;

/** The reads of one bucket shape on a table: by their columns' values, as tuples. */
type Group = { readonly name: string; readonly columns: readonly string[]; readonly byValues: TupleMap<Filed> };

/** A filed read's entries: its table's index, its group and value combinations there, the key sets it is filed by. */
type Filing = {
	readonly index: TableIndex;
	readonly group: Group;
	/**
	 * Its bucket's combinations one after another, `group.columns.length` values each: one list of exactly their
	 * values (a list per combination would cost 56 B more than the identities this replaced).
	 */
	readonly combined: readonly SqliteValue[];
	/** `undefined`: no result to rule a write out by; the read is unindexed until it has one. */
	kept: readonly TupleSet[] | undefined;
};

/**
 * One store's commit index, kept by its `Reads` as reads enter and leave, and by the reads themselves as their kept
 * keys change (`KeptKeysWatcher`).
 */
export class ReadIndex implements KeptKeysWatcher {
	readonly #tables = new Map<string, TableIndex>();
	readonly #filings = new Map<Read, Filing>();

	/** Files `read` under every table it uses: by its bucket on its own table when it has one, else unindexed. */
	add(read: Read): void {
		const { plan } = read;
		const bucket = bucketOf(read);
		for (const use of plan.uses) {
			if (bucket === undefined || use.table !== plan.table) this.#index(use.table).unindexed.add(read);
		}
		if (bucket === undefined) return;
		const index = this.#index(plan.table);
		index.key = plan.query.table.key;
		const group = index.group(bucket.columns);
		for (const values of bucket.combinations) addTo(group.byValues, values, read);
		// Filed by no keys yet: `kept` files it by its result, or as a candidate of every write while it has none.
		this.#filings.set(read, { index, group, combined: flattened(bucket.combinations), kept: NO_KEYS });
		read.watchKept(this);
		this.kept(read);
	}

	/** Removes every entry of `read`. */
	delete(read: Read): void {
		for (const { table } of read.plan.uses) {
			const index = this.#tables.get(table);
			index?.unindexed.delete(read);
			if (index?.isEmpty()) this.#tables.delete(table);
		}
		const filing = this.#filings.get(read);
		if (filing === undefined) return;
		this.#filings.delete(read);
		read.watchKept(undefined);
		const { index, group } = filing;
		const length = group.columns.length;
		for (let at = 0; at < filing.combined.length; at += length) {
			removeFrom(group.byValues, filing.combined.slice(at, at + length), read);
		}
		if (group.byValues.size === 0) index.drop(group);
		this.#unkeep(read, filing);
		if (index.isEmpty()) this.#tables.delete(read.plan.table);
	}

	/** Re-files `read` by the keys it keeps now, unless they are the same sets (a run adopted after its group's step). */
	kept(read: Read): void {
		const filing = this.#filings.get(read)!;
		const kept = read.kept();
		if (kept?.length === filing.kept?.length && (kept ?? NO_KEYS).every((keys, at) => keys === filing.kept![at]))
			return;
		const before = filing.kept;
		filing.kept = kept;
		const { index } = filing;
		const length = index.key!.length;
		if (kept === undefined) {
			for (const keys of before ?? NO_KEYS) eachTuple(keys, length, (key) => removeFrom(index.kept, key, read));
			index.unindexed.add(read);
			return;
		}
		index.unindexed.delete(read);
		// What filing it anew after removing it from every key gave, without the map's removals and insertions of the
		// keys it keeps again (a run of 100 rows keeps 99 of them): a key it no longer keeps loses it; a key it keeps
		// has it last among the reads filed there.
		for (const keys of before ?? NO_KEYS) {
			eachTuple(keys, length, (key) => {
				if (!keepsKey(kept, key)) removeFrom(index.kept, key, read);
			});
		}
		for (const keys of kept) eachTuple(keys, length, (key) => refile(index.kept, key, read));
	}

	/**
	 * The reads of `table` that `changes` (its keyed writes in one step, applied) can concern: each indexed one with
	 * the writes it is a candidate of, added to `into`; returns the unindexed ones, candidates of every write. The rows
	 * after the writes are read back by key in the step when a bucket needs a column outside the key.
	 */
	async candidates(
		table: string,
		changes: readonly KeyedChange[],
		step: Step,
		into: Map<Read, KeyedChange[]>,
	): Promise<ReadonlySet<Read>> {
		const index = this.#tables.get(table);
		if (index === undefined) return NO_READS;
		const { key } = index;
		// No read was ever filed by a bucket here: every read of the table is unindexed.
		if (key === undefined) return index.unindexed;
		const lookup = index.lookup(table);
		// The rows after the writes by key: `null` for a key whose row is gone.
		const after: TupleMap<RowValues | null> = new Map();
		for (const change of changes) {
			addChanges(into, getRow(index.kept, key, change.key), change);
			if (change.kind === "delete" || index.groups.size === 0) continue;
			let row = getRow(after, key, change.key);
			if (row === undefined) {
				// One lookup per written key, only when a bucket fixes a column outside the key.
				row =
					lookup === undefined
						? change.key
						: ((await step.get<RowValues>(lookup, ...key.map((name) => change.key[name]!))) ?? null);
				setRow(after, key, change.key, row);
			}
			if (row === null) continue;
			for (const group of index.groups.values())
				addChanges(into, getRow(group.byValues, group.columns, row), change);
		}
		return index.unindexed;
	}

	#unkeep(read: Read, filing: Filing): void {
		const { index } = filing;
		for (const keys of filing.kept ?? NO_KEYS)
			eachTuple(keys, index.key!.length, (key) => removeFrom(index.kept, key, read));
	}

	#index(table: string): TableIndex {
		return this.#tables.get(table) ?? this.#tables.set(table, new TableIndex()).get(table)!;
	}
}

/** A row's values by column, as read back after a write (or its key, when the buckets need nothing else). */
type RowValues = { readonly [column: string]: SqliteValue };

const NO_READS: ReadonlySet<Read> = new Set();
const NO_KEYS: readonly TupleSet[] = [];

/** The index of one table: its unindexed reads, its buckets by shape, and the reads by the keys they keep. */
class TableIndex {
	/** The table's key columns, known once a read is filed by its bucket (every plan of the table has the same). */
	key: readonly string[] | undefined;
	/** The candidates of every write: reads without a bucket here, and filed reads without a result. */
	readonly unindexed = new Set<Read>();
	/** The groups by their columns, joined. */
	readonly groups = new Map<string, Group>();
	/** The reads by the keys they keep, as tuples of the key's values. */
	readonly kept: TupleMap<Filed> = new Map();
	/** Counts the changes of `groups`: the lookup is rendered again after one, not compared by a text key per commit. */
	#changes = 0;
	/** The statement reading the buckets' columns back by key, for the groups as they were at its change. */
	#lookup: { readonly changes: number; readonly sql: string | undefined } | undefined;

	/** The group of reads whose buckets fix `columns` (sorted). */
	group(columns: readonly string[]): Group {
		const name = columns.join(",");
		let group = this.groups.get(name);
		if (group === undefined) {
			group = { name, columns, byValues: new Map() as TupleMap<Filed> };
			this.groups.set(name, group);
			this.#changes++;
		}
		return group;
	}

	/** Drops `group`, which has no reads left. */
	drop(group: Group): void {
		this.groups.delete(group.name);
		this.#changes++;
	}

	isEmpty(): boolean {
		return this.unindexed.size === 0 && this.groups.size === 0 && this.kept.size === 0;
	}

	/**
	 * The statement reading back, by key, the row a step wrote to `table` in every column a bucket fixes; `undefined`
	 * when the key holds them all (the written key is the row's values then). Rendered again when the groups changed.
	 */
	lookup(table: string): string | undefined {
		const changes = this.#changes;
		if (this.#lookup?.changes === changes) return this.#lookup.sql;
		const key = this.key!;
		const columns = [...new Set([...this.groups.values()].flatMap((group) => group.columns))];
		const where = key.map((column) => `${quote(column)} = ?`).join(" AND ");
		const sql = columns.every((column) => key.includes(column))
			? undefined
			: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)} WHERE ${where}`;
		this.#lookup = { changes, sql };
		return sql;
	}
}

/**
 * How many value combinations a read's bucket may have (the product of its `inArray` lists' lengths); a column whose
 * list would pass it is left out of the bucket (slice 15 §3, decided: 32).
 */
const COMBINATIONS = 32;

/**
 * The bucket of `read` on its own table: the columns its condition fixes and every combination of their values, each
 * once; `undefined` when it has none, uses its own table twice (an `exists` over it), or counts.
 */
function bucketOf(read: Read): { readonly columns: string[]; readonly combinations: SqliteValue[][] } | undefined {
	const { plan } = read;
	if (read.what.kind === "count") return undefined;
	let own = 0;
	for (const use of plan.uses) if (use.table === plan.table) own++;
	if (own > 1) return undefined;
	const columns: string[] = [];
	let combinations: SqliteValue[][] = [[]];
	// Sorted by column: one term (most reads) is sorted already.
	const terms =
		plan.equalities.length > 1 ? [...plan.equalities].sort(([a], [b]) => (a < b ? -1 : 1)) : plan.equalities;
	for (const [column, values] of terms) {
		// An empty `in` matches no row: no bucket of it (a bucket without values would be dropped by its first leaver).
		if (values.length === 0 || combinations.length * values.length > COMBINATIONS) continue;
		columns.push(column);
		combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, value]));
	}
	if (columns.length === 0) return undefined;
	// One combination (every term one value: most reads) is once already.
	if (combinations.length === 1) return { columns, combinations };
	const seen: TupleMap<true> = new Map();
	const once = combinations.filter((values) => {
		if (getTuple(seen, values) !== undefined) return false;
		setTuple(seen, values, true);
		return true;
	});
	return { columns, combinations: once };
}

/** `lists` one after another in one list of exactly their values. */
function flattened(lists: readonly (readonly SqliteValue[])[]): SqliteValue[] {
	let length = 0;
	for (const list of lists) length += list.length;
	const values = new Array<SqliteValue>(length);
	let at = 0;
	for (const list of lists) for (let index = 0; index < list.length; index++) values[at++] = list[index]!;
	return values;
}

/** Adds `change` to each read `filed` holds, in the order they were filed. */
function addChanges(into: Map<Read, KeyedChange[]>, filed: Filed | undefined, change: KeyedChange): void {
	if (filed === undefined) return;
	if (filed instanceof Set) for (const read of filed) addChange(into, read, change);
	else addChange(into, filed, change);
}

function addChange(into: Map<Read, KeyedChange[]>, read: Read, change: KeyedChange): void {
	const changes = into.get(read);
	if (changes === undefined) into.set(read, [change]);
	// A write found by its key and by its bucket is tested once.
	else if (changes.at(-1) !== change) changes.push(change);
}

function addTo(map: TupleMap<Filed>, values: readonly SqliteValue[], read: Read): void {
	const filed = getTuple(map, values);
	if (filed === undefined) setTuple(map, values, read);
	else if (filed instanceof Set) filed.add(read);
	else if (filed !== read) setTuple(map, values, new Set([filed, read]));
}

/** Whether one of the key sets `kept` holds `key`. */
function keepsKey(kept: readonly TupleSet[], key: readonly SqliteValue[]): boolean {
	for (const keys of kept) if (hasTuple(keys, key)) return true;
	return false;
}

/** Files `read` under `key` as the last read there: added, or moved behind the reads filed after it. */
function refile(map: TupleMap<Filed>, key: readonly SqliteValue[], read: Read): void {
	const filed = getTuple(map, key);
	if (filed === read) return;
	if (filed instanceof Set && filed.delete(read)) filed.add(read);
	else addTo(map, key, read);
}

function removeFrom(map: TupleMap<Filed>, values: readonly SqliteValue[], read: Read): void {
	const filed = getTuple(map, values);
	if (filed === undefined) return;
	if (filed instanceof Set) {
		filed.delete(read);
		if (filed.size === 0) deleteTuple(map, values);
	} else if (filed === read) deleteTuple(map, values);
}
