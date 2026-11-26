// Sets and maps of tuples of SQLite values (a row's key, the values a read pairs by, a bucket's combination), compared
// value by value, never by a text: a tuple of one value is the value itself (most keys: a plain set or map), a longer
// one a path of maps, one level per value, its last value in a set or a map of the values. The JSON of a key built
// per fetched row cost about 0.1 µs a row and kept a string per kept key (the hot-path pass, 2026-11-26).

import type { SqliteValue } from "../sqlite/index.ts";

/** A set of tuples of one length: the values for length 1, else a map from a first value to the set of the rest. */
export type TupleSet = Set<unknown> | Map<unknown, TupleSet>;

/** A map from tuples of one length: by the value for length 1, else from a first value to the map of the rest. */
export type TupleMap<V> = Map<unknown, V | TupleMap<V>>;

/** A row's values by column, as reads and writes have them. */
type Row = { readonly [column: string]: SqliteValue | undefined };

/** An empty set of tuples of `length` values. */
export function tupleSet(length: number): TupleSet {
	return length === 1 ? new Set() : new Map();
}

/** Adds the tuple of `row`'s values in `columns` to `set`, made for tuples of their length. */
export function addRow(set: TupleSet, columns: readonly string[], row: Row): void {
	let at: TupleSet = set;
	for (let index = 0; index < columns.length - 1; index++) {
		// Made for tuples of `columns.length` values: every level before the last is a map.
		const level = at as Map<unknown, TupleSet>;
		const value = row[columns[index]!];
		let next = level.get(value);
		if (next === undefined) {
			next = index === columns.length - 2 ? new Set() : new Map();
			level.set(value, next);
		}
		at = next;
	}
	(at as Set<unknown>).add(row[columns[columns.length - 1]!]);
}

/** Whether `set` holds the tuple `values`. */
export function hasTuple(set: TupleSet, values: readonly SqliteValue[]): boolean {
	let at: TupleSet | undefined = set;
	for (let index = 0; index < values.length - 1 && at !== undefined; index++) {
		at = (at as Map<unknown, TupleSet>).get(values[index]);
	}
	return at !== undefined && (at as Set<unknown>).has(values[values.length - 1]);
}

/** Whether `set` holds the tuple of `row`'s values in `columns`. */
export function hasRow(set: TupleSet, columns: readonly string[], row: Row): boolean {
	let at: TupleSet | undefined = set;
	for (let index = 0; index < columns.length - 1 && at !== undefined; index++) {
		at = (at as Map<unknown, TupleSet>).get(row[columns[index]!]);
	}
	return at !== undefined && (at as Set<unknown>).has(row[columns[columns.length - 1]!]);
}

/**
 * Calls `visit` with every tuple of `set` (of `length` values), in the order added within each level. `visit` gets one
 * list, refilled for each tuple: valid during the call only.
 */
export function eachTuple(set: TupleSet, length: number, visit: (values: readonly SqliteValue[]) => void): void {
	const values = new Array<SqliteValue>(length);
	const walk = (at: TupleSet, depth: number): void => {
		if (depth === length - 1) {
			for (const value of at as Set<unknown>) {
				values[depth] = value as SqliteValue;
				visit(values);
			}
			return;
		}
		for (const [value, rest] of at as Map<unknown, TupleSet>) {
			values[depth] = value as SqliteValue;
			walk(rest, depth + 1);
		}
	};
	walk(set, 0);
}

/** The value `map` has for the tuple `values`. */
export function getTuple<V>(map: TupleMap<V>, values: readonly SqliteValue[]): V | undefined {
	let at: TupleMap<V> | undefined = map;
	for (let index = 0; index < values.length - 1 && at !== undefined; index++) {
		// Every level before the last holds maps (a tuple map is used with tuples of one length).
		at = at.get(values[index]) as TupleMap<V> | undefined;
	}
	return at?.get(values[values.length - 1]) as V | undefined;
}

/** The value `map` has for the tuple of `row`'s values in `columns`. */
export function getRow<V>(map: TupleMap<V>, columns: readonly string[], row: Row): V | undefined {
	let at: TupleMap<V> | undefined = map;
	for (let index = 0; index < columns.length - 1 && at !== undefined; index++) {
		at = at.get(row[columns[index]!]) as TupleMap<V> | undefined;
	}
	return at?.get(row[columns[columns.length - 1]!]) as V | undefined;
}

/** Sets `map`'s value for the tuple `values` (the list is not kept). */
export function setTuple<V>(map: TupleMap<V>, values: readonly SqliteValue[], value: V): void {
	let at = map;
	for (let index = 0; index < values.length - 1; index++) at = levelOf(at, values[index]);
	at.set(values[values.length - 1], value);
}

/** Sets `map`'s value for the tuple of `row`'s values in `columns`. */
export function setRow<V>(map: TupleMap<V>, columns: readonly string[], row: Row, value: V): void {
	let at = map;
	for (let index = 0; index < columns.length - 1; index++) at = levelOf(at, row[columns[index]!]);
	at.set(row[columns[columns.length - 1]!], value);
}

/** The level of `map` under `value`, made when missing. */
function levelOf<V>(map: TupleMap<V>, value: unknown): TupleMap<V> {
	// Every level before the last holds maps (a tuple map is used with tuples of one length).
	let next = map.get(value) as TupleMap<V> | undefined;
	if (next === undefined) {
		next = new Map();
		map.set(value, next);
	}
	return next;
}

/** Deletes `map`'s value for the tuple `values`, and every level it leaves empty. */
export function deleteTuple<V>(map: TupleMap<V>, values: readonly SqliteValue[]): void {
	if (values.length === 1) {
		map.delete(values[0]);
		return;
	}
	const levels: TupleMap<V>[] = [map];
	for (let index = 0; index < values.length - 1; index++) {
		const next = levels[index]!.get(values[index]) as TupleMap<V> | undefined;
		if (next === undefined) return;
		levels.push(next);
	}
	for (let index = values.length - 1; index >= 0; index--) {
		const level = levels[index]!;
		level.delete(values[index]);
		if (level.size > 0) return;
	}
}
