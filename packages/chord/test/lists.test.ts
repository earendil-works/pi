// Tests of short lists (`lists.ts`): `appended` adds without the slack a `push` reserves, copies a short list and
// grows a long one in place; `NO_ITEMS` is never written.

import { describe, expect, it } from "vitest";
import { appended, NO_ITEMS } from "../src/lists.ts";
import { settledHeap } from "./support.ts";

describe("appended", () => {
	it("makes a list of the one item from the shared empty one, which stays empty", () => {
		const list = appended<string>(NO_ITEMS, "a");
		expect([list, NO_ITEMS]).toEqual([["a"], []]);
		expect(list).not.toBe(NO_ITEMS);
	});

	it("copies a short list, in order, leaving the one it was given as it was", () => {
		const one = appended<string>(NO_ITEMS, "a");
		const two = appended(one, "b");
		const three = appended(two, "c");
		expect([one, two, three]).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
		expect(two).not.toBe(one);
	});

	it("adds an item that is a list as one item", () => {
		const pair: readonly string[] = ["x", "y"];
		const list = appended(appended<readonly string[]>(NO_ITEMS, pair), pair);
		expect(list).toEqual([pair, pair]);
		expect(list[1]).toBe(pair);
	});

	it("grows a list of eight or more in place", () => {
		let list: readonly number[] = NO_ITEMS;
		for (let item = 0; item < 8; item++) list = appended(list, item);
		const long = list;
		for (let item = 8; item < 20; item++) list = appended(list, item);
		expect(list).toBe(long);
		expect(list).toEqual(Array.from({ length: 20 }, (_, item) => item));
	});

	it("keeps a list of one item in a third of what a pushed-to array takes", async () => {
		const COUNT = 20_000;
		const measure = async (make: (item: object) => readonly object[]): Promise<number> => {
			const item = {};
			const before = await settledHeap();
			const lists = Array.from({ length: COUNT }, () => make(item));
			const per = ((await settledHeap()) - before) / COUNT;
			expect(lists.length).toBe(COUNT);
			return per;
		};
		const pushed = await measure((item) => {
			const list: object[] = [];
			list.push(item);
			return list;
		});
		const made = await measure((item) => appended<object>(NO_ITEMS, item));
		// Measured: 192 B pushed (room for 17 items), 64 B appended (the array and its one slot, and the outer list's slot).
		expect(made).toBeLessThan(100);
		expect(pushed).toBeGreaterThan(made * 2);
	});
});
