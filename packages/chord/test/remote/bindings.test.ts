import { describe, expect, it } from "vitest";
import { Bindings } from "../../src/remote/bindings.ts";
import { settledHeap } from "../support.ts";

describe("bindings", () => {
	it("keep a set's membership and order under random adds, deletes and clears", () => {
		let seed = 7;
		const random = (below: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % below;
		};
		const members = ["a", "b", "c", "d", "e"];
		for (let run = 0; run < 200; run++) {
			const set = new Set<string>();
			const bindings = new Bindings<string>();
			for (let step = 0; step < 60; step++) {
				const member = members[random(members.length)]!;
				const op = random(10);
				if (op < 5) {
					set.add(member);
					bindings.add(member);
				} else if (op < 9) {
					expect(bindings.delete(member)).toBe(set.delete(member));
				} else {
					set.clear();
					bindings.clear();
				}
				expect(bindings.list()).toEqual([...set]);
				expect(bindings.size).toBe(set.size);
				for (const each of members) expect(bindings.has(each)).toBe(set.has(each));
			}
		}
	});

	it("hand out a copy: changing them after leaves a list taken before as it was", () => {
		const bindings = new Bindings<string>();
		bindings.add("a");
		bindings.add("b");
		const list = bindings.list();
		bindings.delete("a");
		bindings.add("c");
		expect(list).toEqual(["a", "b"]);
		expect(bindings.list()).toEqual(["b", "c"]);
	});

	it("with one member keep no set: under half a set's heap", async () => {
		const kept: Bindings<object>[] = [];
		const make = (count: number) => {
			for (let index = 0; index < count; index++) {
				const bindings = new Bindings<object>();
				bindings.add({});
				kept.push(bindings);
			}
		};
		make(2_000);
		const before = await settledHeap();
		make(10_000);
		const per = ((await settledHeap()) - before) / 10_000;
		// About 50 B with its member (16 B) and the list's slot; a `Set` of one costs 152 B on its own.
		expect(per).toBeLessThan(110);
		expect(kept).toHaveLength(12_000);
	});
});
