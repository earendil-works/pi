// Tests of a set that keeps one member without a `Set` (`small-set.ts`): size, add, delete and clear; iterated while its
// members change (added, removed, cleared, added again, iterated again inside), it yields what a `Set`'s iteration
// yields, in its order (named cases and random ones against a `Set`); one member keeps no set (cost guard).

import { describe, expect, it } from "vitest";
import { SmallSet } from "../src/small-set.ts";
import { settledHeap } from "./support.ts";

/** What a case uses of a set: a `SmallSet`, or a `Set`. */
type Members = Pick<SmallSet<number>, "add" | "delete" | "clear" | "size"> &
	Iterable<number> & { forEach(each: (member: number) => void): void };

/** A seeded generator of numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One step of a random case: a change of the members, or an iteration (stopped early when `stop`). */
type Step =
	| { readonly kind: "add"; readonly who: number }
	| { readonly kind: "delete"; readonly who: number }
	| { readonly kind: "clear" }
	| { readonly kind: "iterate"; readonly stop: number }
	| { readonly kind: "forEach" };

function step(next: () => number): Step {
	const roll = next();
	const who = Math.floor(next() * 4);
	if (roll < 0.4) return { kind: "add", who };
	if (roll < 0.7) return { kind: "delete", who };
	if (roll < 0.8) return { kind: "clear" };
	if (roll < 0.9) return { kind: "forEach" };
	return { kind: "iterate", stop: Math.floor(next() * 5) };
}

/**
 * Runs the case of `seed` on `members`: six steps from outside; at each member an iteration yields, up to three
 * steps of its own the first times (so the case ends). Logs what each iteration yielded and the size after each step.
 */
function trace(seed: number, members: Members): string {
	const next = random(seed);
	const log: string[] = [];
	// The steps taken at the n-th member any iteration yields.
	const inside = Array.from({ length: 12 }, () => Array.from({ length: Math.floor(next() * 4) }, () => step(next)));
	let yielded = 0;
	const take = (taken: Step, depth: number): void => {
		if (taken.kind === "add") members.add(taken.who);
		else if (taken.kind === "delete") log.push(`d${taken.who}:${members.delete(taken.who)}`);
		else if (taken.kind === "clear") members.clear();
		else if (taken.kind === "forEach") {
			log.push(`{${depth}`);
			members.forEach((member) => {
				log.push(`${member}`);
				for (const own of inside[yielded++] ?? []) if (depth < 3) take(own, depth + 1);
			});
			log.push("}");
		} else {
			let count = 0;
			log.push(`[${depth}`);
			for (const member of members) {
				log.push(`${member}`);
				if (++count > taken.stop) break;
				for (const own of inside[yielded++] ?? []) if (depth < 3) take(own, depth + 1);
			}
			log.push("]");
		}
	};
	for (let index = 0; index < 6; index++) {
		take(step(next), 0);
		log.push(`(${members.size})`);
	}
	log.push(`left ${[...members].join(",")}`);
	if (members instanceof SmallSet) log.push(`snapshot ${members.snapshot().join(",")}`);
	else log.push(`snapshot ${[...members].join(",")}`);
	return log.join(" ");
}

describe("a small set", () => {
	it("counts none, one and several; adds a member once; deletes one, the only one and one that is none", () => {
		const members = new SmallSet<string>();
		expect([members.size, members.delete("a")]).toEqual([0, false]);
		members.add("a");
		members.add("a");
		expect([members.size, [...members]]).toEqual([1, ["a"]]);
		members.add("b");
		members.add("a");
		expect([members.size, [...members]]).toEqual([2, ["a", "b"]]);
		expect([members.delete("a"), members.delete("a"), [...members]]).toEqual([true, false, ["b"]]);
		members.clear();
		expect([members.size, [...members]]).toEqual([0, []]);
	});

	it("yields a member added during an iteration of one, and the next one after the only one is replaced", () => {
		const members = new SmallSet<string>();
		members.add("a");
		const seen: string[] = [];
		for (const member of members) {
			seen.push(member);
			if (member === "a") members.add("b");
		}
		const replaced = new SmallSet<string>();
		replaced.add("x");
		for (const member of replaced) {
			seen.push(member);
			if (member === "x") {
				replaced.delete("x");
				replaced.add("y");
			}
		}
		expect(seen).toEqual(["a", "b", "x", "y"]);
	});

	it("yields and tells what a Set's iteration and forEach do, whatever they change meanwhile (5,000 random cases)", () => {
		for (let seed = 1; seed <= 5_000; seed++) {
			expect([seed, trace(seed, new SmallSet<number>())]).toEqual([seed, trace(seed, new Set<number>())]);
		}
	});

	it("keeps one member without a set (cost guard)", async () => {
		const kept: SmallSet<object>[] = [];
		const before = await settledHeap();
		for (let index = 0; index < 10_000; index++) {
			const members = new SmallSet<object>();
			members.add(kept);
			kept.push(members);
		}
		const each = ((await settledHeap()) - before) / kept.length;
		// Measured about 30 B with its list slot; a set of one was 184 B more.
		expect(each).toBeLessThan(100);
	});
});
