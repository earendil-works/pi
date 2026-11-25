// The commit index of a store's reads (slice 15 §3): which reads a commit's keyed writes to a table can concern, so
// the commit step skip-tests those alone. A read whose condition fixes own columns with `eq` or `inArray` is filed
// under their values (its bucket) and the keys of its last result's rows; any other is unindexed. A write's
// candidates: the reads holding its key (the row was in their result), those whose bucket the row after the write
// matches (it may be now) and the unindexed ones. A pure speedup: a read that neither held the row nor can hold it
// after is one the skip test would skip.

import type { SqliteValue } from "../sqlite/index.ts";
import { identity, identityOf, type KeptKeysWatcher, type Read } from "./read.ts";
import type { KeyedChange } from "./skip.ts";
import { quote } from "./sql.ts";
import type { Step } from "./step.ts";

/** The reads of one bucket shape on a table: by the identity of their columns' values. */
type Group = { readonly columns: readonly string[]; readonly byValues: Map<unknown, Set<Read>> };

/** A filed read's entries: its table's index, its group and value identities there, the key sets it is filed by. */
type Filing = {
	readonly index: TableIndex;
	readonly group: Group;
	readonly identities: readonly unknown[];
	/** `undefined`: no result to rule a write out by; the read is unindexed until it has one. */
	kept: readonly ReadonlySet<unknown>[] | undefined;
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
		for (const id of bucket.identities) addTo(group.byValues, id, read);
		// Filed by no keys yet: `kept` files it by its result, or as a candidate of every write while it has none.
		this.#filings.set(read, { index, group, identities: bucket.identities, kept: NO_KEYS });
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
		for (const id of filing.identities) removeFrom(group.byValues, id, read);
		if (group.byValues.size === 0) index.groups.delete(group.columns.join(","));
		this.#unkeep(read, filing);
		if (index.isEmpty()) this.#tables.delete(read.plan.table);
	}

	/** Re-files `read` by the keys it keeps now, unless they are the same sets (a run adopted after its group's step). */
	kept(read: Read): void {
		const filing = this.#filings.get(read)!;
		const kept = read.kept();
		if (kept?.length === filing.kept?.length && (kept ?? NO_KEYS).every((keys, at) => keys === filing.kept![at]))
			return;
		this.#unkeep(read, filing);
		filing.kept = kept;
		const { index } = filing;
		if (kept === undefined) {
			index.unindexed.add(read);
			return;
		}
		index.unindexed.delete(read);
		for (const keys of kept) for (const key of keys) addTo(index.kept, key, read);
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
		const after = new Map<unknown, RowValues | undefined>();
		for (const change of changes) {
			const id = identityOf(key.map((name) => change.key[name]!));
			for (const read of index.kept.get(id) ?? NO_READS) addChange(into, read, change);
			if (change.kind === "delete" || index.groups.size === 0) continue;
			let row = after.get(id);
			if (!after.has(id)) {
				// One lookup per written key, only when a bucket fixes a column outside the key.
				row =
					lookup === undefined
						? change.key
						: await step.get<RowValues>(lookup, ...key.map((name) => change.key[name]!));
				after.set(id, row);
			}
			if (row === undefined) continue;
			for (const group of index.groups.values()) {
				for (const read of group.byValues.get(identity(group.columns, row)) ?? NO_READS)
					addChange(into, read, change);
			}
		}
		return index.unindexed;
	}

	#unkeep(read: Read, filing: Filing): void {
		for (const keys of filing.kept ?? NO_KEYS) for (const key of keys) removeFrom(filing.index.kept, key, read);
	}

	#index(table: string): TableIndex {
		return this.#tables.get(table) ?? this.#tables.set(table, new TableIndex()).get(table)!;
	}
}

/** A row's values by column, as read back after a write (or its key, when the buckets need nothing else). */
type RowValues = { readonly [column: string]: SqliteValue };

const NO_READS: ReadonlySet<Read> = new Set();
const NO_KEYS: readonly ReadonlySet<unknown>[] = [];

/** The index of one table: its unindexed reads, its buckets by shape, and the reads by the keys they keep. */
class TableIndex {
	/** The table's key columns, known once a read is filed by its bucket (every plan of the table has the same). */
	key: readonly string[] | undefined;
	/** The candidates of every write: reads without a bucket here, and filed reads without a result. */
	readonly unindexed = new Set<Read>();
	/** The groups by their columns, joined. */
	readonly groups = new Map<string, Group>();
	readonly kept = new Map<unknown, Set<Read>>();
	/** The statement reading the buckets' columns back by key, for the groups it was rendered for. */
	#lookup: { readonly groups: string; readonly sql: string | undefined } | undefined;

	/** The group of reads whose buckets fix `columns` (sorted). */
	group(columns: readonly string[]): Group {
		const name = columns.join(",");
		return this.groups.get(name) ?? this.groups.set(name, { columns, byValues: new Map() }).get(name)!;
	}

	isEmpty(): boolean {
		return this.unindexed.size === 0 && this.groups.size === 0 && this.kept.size === 0;
	}

	/**
	 * The statement reading back, by key, the row a step wrote to `table` in every column a bucket fixes; `undefined`
	 * when the key holds them all (the written key is the row's values then). Rendered again when the groups changed.
	 */
	lookup(table: string): string | undefined {
		const groups = [...this.groups.keys()].join("|");
		if (this.#lookup?.groups === groups) return this.#lookup.sql;
		const key = this.key!;
		const columns = [...new Set([...this.groups.values()].flatMap((group) => group.columns))];
		const where = key.map((column) => `${quote(column)} = ?`).join(" AND ");
		const sql = columns.every((column) => key.includes(column))
			? undefined
			: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)} WHERE ${where}`;
		this.#lookup = { groups, sql };
		return sql;
	}
}

/**
 * How many value combinations a read's bucket may have (the product of its `inArray` lists' lengths); a column whose
 * list would pass it is left out of the bucket (slice 15 §3, decided: 32).
 */
const COMBINATIONS = 32;

/**
 * The bucket of `read` on its own table: the columns its condition fixes and the identity of every combination of
 * their values; `undefined` when it has none, uses its own table twice (an `exists` over it), or counts.
 */
function bucketOf(read: Read): { readonly columns: string[]; readonly identities: unknown[] } | undefined {
	const { plan } = read;
	if (read.what.kind === "count") return undefined;
	if (plan.uses.filter((use) => use.table === plan.table).length > 1) return undefined;
	const columns: string[] = [];
	let combinations: SqliteValue[][] = [[]];
	for (const [column, values] of [...plan.equalities].sort(([a], [b]) => (a < b ? -1 : 1))) {
		// An empty `in` matches no row: no bucket of it (a bucket without values would be dropped by its first leaver).
		if (values.length === 0 || combinations.length * values.length > COMBINATIONS) continue;
		columns.push(column);
		combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, value]));
	}
	if (columns.length === 0) return undefined;
	return { columns, identities: [...new Set(combinations.map(identityOf))] };
}

function addChange(into: Map<Read, KeyedChange[]>, read: Read, change: KeyedChange): void {
	const changes = into.get(read);
	if (changes === undefined) into.set(read, [change]);
	// A write found by its key and by its bucket is tested once.
	else if (changes.at(-1) !== change) changes.push(change);
}

function addTo<K>(map: Map<K, Set<Read>>, key: K, read: Read): void {
	const reads = map.get(key);
	if (reads === undefined) map.set(key, new Set([read]));
	else reads.add(read);
}

function removeFrom<K>(map: Map<K, Set<Read>>, key: K, read: Read): void {
	const reads = map.get(key);
	if (reads === undefined) return;
	reads.delete(read);
	if (reads.size === 0) map.delete(key);
}
