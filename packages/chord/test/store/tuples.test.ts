// Sets and maps of tuples (the hot-path pass): random operations against a set and a map keyed by each tuple's JSON,
// the identity they replace, for tuples of one to three SQLite values; empty levels are dropped.

import { describe, expect, it } from "vitest";
import type { SqliteValue } from "../../src/sqlite/index.ts";
import {
	addRow,
	deleteTuple,
	eachTuple,
	getRow,
	getTuple,
	hasRow,
	hasTuple,
	OneTuple,
	setRow,
	setTuple,
	type TupleMap,
	tupleSet,
	tuplesOf,
} from "../../src/store/tuples.ts";

const VALUES: readonly SqliteValue[] = ["a", "b", "", "1", 1, 0, 2.5, -1, null];

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const COLUMNS = ["c0", "c1", "c2"];

describe("tuple sets and maps", () => {
	for (const length of [1, 2, 3]) {
		it(`behave as a set and a map keyed by the tuple's JSON, tuples of ${length}`, () => {
			const next = random(length);
			const pick = (): SqliteValue[] => Array.from({ length }, () => VALUES[Math.floor(next() * VALUES.length)]!);
			const columns = COLUMNS.slice(0, length);
			const rowOf = (values: readonly SqliteValue[]) => Object.fromEntries(columns.map((c, at) => [c, values[at]!]));
			const set = tupleSet(length);
			const reference = new Set<string>();
			const map: TupleMap<number> = new Map();
			const referenceMap = new Map<string, number>();
			for (let step = 0; step < 2_000; step++) {
				const values = pick();
				const json = JSON.stringify(values);
				const choice = next();
				if (choice < 0.3) {
					addRow(set, columns, rowOf(values));
					reference.add(json);
				} else if (choice < 0.5) {
					setTuple(map, values, step);
					referenceMap.set(json, step);
				} else if (choice < 0.6) {
					setRow(map, columns, rowOf(values), -step);
					referenceMap.set(json, -step);
				} else if (choice < 0.8) {
					deleteTuple(map, values);
					referenceMap.delete(json);
				}
				expect(hasTuple(set, values)).toBe(reference.has(json));
				expect(hasRow(set, columns, rowOf(values))).toBe(reference.has(json));
				expect(getTuple(map, values)).toBe(referenceMap.get(json));
				expect(getRow(map, columns, rowOf(values))).toBe(referenceMap.get(json));
			}
			const visited: string[] = [];
			eachTuple(set, length, (values) => visited.push(JSON.stringify(values)));
			expect(visited.sort()).toEqual([...reference].sort());
			// Every value deleted: no level is left behind.
			for (const json of [...referenceMap.keys()]) deleteTuple(map, JSON.parse(json) as SqliteValue[]);
			expect(map.size).toBe(0);
		});
	}

	it("made of rows, hold exactly their tuples: one row's without a set, several in one", () => {
		const next = random(7);
		for (const length of [1, 2, 3]) {
			const columns = COLUMNS.slice(0, length);
			for (let round = 0; round < 200; round++) {
				const count = Math.floor(next() * 4);
				const rows = Array.from({ length: count }, () =>
					Object.fromEntries(columns.map((c) => [c, VALUES[Math.floor(next() * VALUES.length)]!])),
				);
				const set = tuplesOf(columns, rows);
				expect(set instanceof OneTuple).toBe(count === 1);
				const reference = new Set(rows.map((row) => JSON.stringify(columns.map((c) => row[c]))));
				for (const value of VALUES) {
					const values = Array.from({ length }, (_, at) => (at === 0 ? value : rows[0]?.[columns[at]!]) ?? null);
					expect(hasTuple(set, values)).toBe(reference.has(JSON.stringify(values)));
					const row = Object.fromEntries(columns.map((c, at) => [c, values[at]!]));
					expect(hasRow(set, columns, row)).toBe(reference.has(JSON.stringify(values)));
				}
				const visited: string[] = [];
				eachTuple(set, length, (values) => visited.push(JSON.stringify(values)));
				expect(visited.sort()).toEqual([...reference].sort());
			}
		}
	});

	it("tells 0 from '0', null from 'null', and holds -0 as 0, as the JSON did", () => {
		const set = tupleSet(2);
		addRow(set, ["a", "b"], { a: 0, b: null });
		expect(hasTuple(set, ["0", null])).toBe(false);
		expect(hasTuple(set, [0, "null"])).toBe(false);
		expect(hasTuple(set, [-0, null])).toBe(true);
	});
});
