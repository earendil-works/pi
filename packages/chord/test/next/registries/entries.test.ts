import { describe, expect, it } from "vitest";
import {
	keyedEntries,
	orderedEntries,
	type RegistryConflict,
	type RegistryTable,
} from "../../../src/next/registries/index.ts";

const table: RegistryTable<{ readonly routes?: Readonly<Record<string, string>>; readonly items?: readonly string[] }> =
	[
		{ plugin: "@a/one", version: 1, value: { routes: { "/x": "one", "/y": "one" }, items: ["late", "first"] } },
		{ plugin: "@b/two", type: "b.store", version: 1, value: { routes: { "/x": "two" }, items: ["second"] } },
		{ plugin: "@c/three", version: 1, value: {} },
	];

describe("keyedEntries", () => {
	it("maps every entry's keys with their plugin; a duplicate is reported and the first by plugin name keeps it", () => {
		const conflicts: RegistryConflict[] = [];
		const map = keyedEntries(
			table,
			(value) => value.routes,
			(conflict) => conflicts.push(conflict),
		);
		expect([...map]).toEqual([
			["/x", { value: "one", plugin: "@a/one" }],
			["/y", { value: "one", plugin: "@a/one" }],
		]);
		expect(conflicts).toEqual([{ message: '"/x" is contributed twice', plugins: ["@a/one", "@b/two"] }]);
	});
});

describe("orderedEntries", () => {
	it("lists every entry's items in table order, with their plugin and type", () => {
		expect(orderedEntries(table, (value) => value.items)).toEqual([
			{ value: "late", plugin: "@a/one" },
			{ value: "first", plugin: "@a/one" },
			{ value: "second", plugin: "@b/two", type: "b.store" },
		]);
	});

	it("sorts by `orderOf`, table order kept among equals", () => {
		const order = (item: string) => (item === "first" ? 0 : 1);
		expect(orderedEntries(table, (value) => value.items, order).map(({ value }) => value)).toEqual([
			"first",
			"late",
			"second",
		]);
	});
});
