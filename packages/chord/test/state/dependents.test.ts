// Tests of a source's dependents (`dependents.ts`): none, one or several in the order added, each once; marks reach
// every dependent, one added during a mark too; whatever dependents do while they are told (add, remove, clear, tell
// again), it tells whom a set's iteration tells, in its order (named cases and random ones against a `Set`); a source
// with one dependent keeps no set.

import { describe, expect, it } from "vitest";
import { Dependents } from "../../src/state/dependents.ts";
import type { Dependent } from "../../src/state/internal.ts";
import { settledHeap } from "../support.ts";

/** A dependent that logs its marks as `name`, and what it was told of a retirement. */
function dependent(name: string, log: string[], onMark: () => void = () => {}): Dependent {
	return {
		invalidate: () => {
			log.push(name);
			onMark();
		},
		sourceRetired: (visited) => void log.push(`${name} retired (${visited.size})`),
	};
}

/** What a random case uses of dependents: a `Dependents`, or the set it stands for. */
type Told = Pick<Dependents, "add" | "delete" | "clear" | "invalidate" | "sourceRetired" | "size">;

/** A set of dependents told by its iteration: what `Dependents` must tell like. */
function asSet(): Told {
	const set = new Set<Dependent>();
	return {
		add: (dependent) => void set.add(dependent),
		delete: (dependent) => void set.delete(dependent),
		clear: () => set.clear(),
		invalidate: () => {
			for (const dependent of set) dependent.invalidate();
		},
		sourceRetired: (visited) => {
			for (const dependent of set) dependent.sourceRetired(visited);
		},
		get size() {
			return set.size;
		},
	};
}

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

/** One step of a random case: a change of the dependents, or telling them. `who` indexes the case's dependents. */
type Step =
	| { readonly kind: "add" | "delete"; readonly who: number }
	| { readonly kind: "clear" | "invalidate" | "sourceRetired" };

/** A random step among four dependents; one taken by a dependent (`self`) is about itself half of the time. */
function step(next: () => number, self?: number): Step {
	const roll = next();
	const other = Math.floor(next() * 4);
	const who = self !== undefined && next() < 0.5 ? self : other;
	if (roll < 0.4) return { kind: "add", who };
	if (roll < 0.7) return { kind: "delete", who };
	if (roll < 0.8) return { kind: "clear" };
	return roll < 0.9 ? { kind: "invalidate" } : { kind: "sourceRetired" };
}

/**
 * The case of `seed`: four dependents, each with one to three steps for each of the first times it is told (up to
 * three times; then none, so the case ends), and six steps from outside.
 */
function caseOf(seed: number): { readonly inside: Step[][][]; readonly outside: Step[] } {
	const next = random(seed);
	const steps = (count: number, self?: number): Step[] => Array.from({ length: count }, () => step(next, self));
	const times = (self: number): Step[][] =>
		Array.from({ length: Math.floor(next() * 4) }, () => steps(1 + Math.floor(next() * 3), self));
	return { inside: Array.from({ length: 4 }, (_, self) => times(self)), outside: steps(6) };
}

/** Runs the case of `seed` on `dependents`: who was told what, in order, with the size after each outside step. */
function trace(seed: number, dependents: Told): string {
	const { inside, outside } = caseOf(seed);
	const log: string[] = [];
	const visited = new Set<Dependent>();
	const all: Dependent[] = inside.map((times, who) => {
		const left = [...times];
		const told = (how: string): void => {
			log.push(`${who}${how}`);
			for (const taken of left.shift() ?? []) take(taken);
		};
		return { invalidate: () => told("i"), sourceRetired: () => told("r") };
	});
	const take = (taken: Step): void => {
		if (taken.kind === "add") dependents.add(all[taken.who]!);
		else if (taken.kind === "delete") dependents.delete(all[taken.who]!);
		else if (taken.kind === "clear") dependents.clear();
		else if (taken.kind === "invalidate") dependents.invalidate();
		else dependents.sourceRetired(visited);
	};
	for (const taken of outside) {
		take(taken);
		log.push(`(${dependents.size})`);
	}
	// Who is left, in order.
	dependents.invalidate();
	return log.join(" ");
}

describe("a source's dependents", () => {
	it("counts none, one and several; adding one twice adds it once", () => {
		const dependents = new Dependents();
		const [a, b] = [dependent("a", []), dependent("b", [])];
		expect(dependents.size).toBe(0);
		dependents.add(a);
		dependents.add(a);
		expect(dependents.size).toBe(1);
		dependents.add(b);
		dependents.add(b);
		dependents.add(a);
		expect(dependents.size).toBe(2);
	});

	it("removes one, the only one, and one that is none", () => {
		const dependents = new Dependents();
		const [a, b, c] = [dependent("a", []), dependent("b", []), dependent("c", [])];
		dependents.delete(a);
		dependents.add(a);
		dependents.delete(b);
		expect(dependents.size).toBe(1);
		dependents.delete(a);
		expect(dependents.size).toBe(0);
		dependents.add(a);
		dependents.add(b);
		dependents.add(c);
		dependents.delete(b);
		dependents.delete(b);
		expect(dependents.size).toBe(2);
		dependents.clear();
		expect(dependents.size).toBe(0);
	});

	it("marks every dependent once, in the order added", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		dependents.invalidate();
		dependents.add(dependent("a", log));
		dependents.invalidate();
		dependents.add(dependent("b", log));
		dependents.add(dependent("c", log));
		dependents.invalidate();
		expect(log).toEqual(["a", "a", "b", "c"]);
	});

	it("marks a dependent added during the mark of the only one, and none removed during it", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const late = dependent("late", log);
		const first = dependent("first", log, () => dependents.add(late));
		dependents.add(first);
		dependents.invalidate();
		expect(log).toEqual(["first", "late"]);
		log.length = 0;
		const alone = new Dependents();
		const leaving: Dependent = dependent("leaving", log, () => alone.delete(leaving));
		alone.add(leaving);
		alone.invalidate();
		alone.invalidate();
		expect([log, alone.size]).toEqual([["leaving"], 0]);
	});

	it("marks the one that replaced the only one during its mark", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const next = dependent("next", log);
		const first: Dependent = dependent("first", log, () => {
			dependents.delete(first);
			dependents.add(next);
		});
		dependents.add(first);
		dependents.invalidate();
		expect([log, dependents.size]).toEqual([["first", "next"], 1]);
	});

	// The three cases a review of the hold-memory pass found telling other than a set (2026-11-25).
	it("tells of a retirement the one the only one added while it was told", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const late: Dependent = { invalidate: () => {}, sourceRetired: () => void log.push("late") };
		dependents.add({
			invalidate: () => {},
			sourceRetired: () => {
				log.push("first");
				dependents.add(late);
			},
		});
		dependents.sourceRetired(new Set());
		expect(log).toEqual(["first", "late"]);
	});

	it("marks the only one again when it removed and added itself during its mark", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const again: Dependent = dependent("again", log, () => {
			if (log.length > 1) return;
			dependents.delete(again);
			dependents.add(again);
		});
		dependents.add(again);
		dependents.invalidate();
		expect([log, dependents.size]).toEqual([["again", "again"], 1]);
	});

	it("marks the only one again, then the one it added, when it removed and added itself before", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const late = dependent("late", log);
		const again: Dependent = dependent("again", log, () => {
			if (log.length > 1) return;
			dependents.delete(again);
			dependents.add(again);
			dependents.add(late);
		});
		dependents.add(again);
		dependents.invalidate();
		expect([log, dependents.size]).toEqual([["again", "again", "late"], 2]);
	});

	it("marks the one added after a clear during a mark, and none of the cleared", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const next = dependent("next", log);
		const clearing = dependent("clearing", log, () => {
			dependents.clear();
			dependents.add(next);
		});
		dependents.add(clearing);
		dependents.add(dependent("cleared", log));
		dependents.invalidate();
		expect([log, dependents.size]).toEqual([["clearing", "next"], 1]);
	});

	it("tells whom a set's iteration tells, whatever dependents do while they are told (5,000 random cases)", () => {
		let several = 0;
		for (let seed = 1; seed <= 5000; seed++) {
			const expected = trace(seed, asSet());
			expect(trace(seed, new Dependents()), `seed ${seed}`).toBe(expected);
			if (/\((?:[2-4])\)/.test(expected)) several++;
		}
		// Not trivial: most cases reach several dependents, the rest stay with none or one.
		expect(several).toBeGreaterThan(2000);
		expect(several).toBeLessThan(5000);
	});

	it("tells every dependent of a retirement, with what was visited", () => {
		const log: string[] = [];
		const dependents = new Dependents();
		const visited = new Set<Dependent>();
		dependents.sourceRetired(visited);
		dependents.add(dependent("a", log));
		dependents.sourceRetired(visited);
		dependents.add(dependent("b", log));
		dependents.sourceRetired(visited);
		expect(log).toEqual(["a retired (0)", "a retired (0)", "b retired (0)"]);
	});

	it("keeps one dependent without a set: under 100 B a source, where a set of one took 220", async () => {
		const COUNT = 20_000;
		const one = dependent("a", []);
		const measure = async (make: () => object): Promise<number> => {
			const before = await settledHeap();
			const made = Array.from({ length: COUNT }, make);
			const per = ((await settledHeap()) - before) / COUNT;
			expect(made.length).toBe(COUNT);
			return per;
		};
		const sets = await measure(() => new Set([one]));
		const kept = await measure(() => {
			const dependents = new Dependents();
			dependents.add(one);
			return dependents;
		});
		expect(kept).toBeLessThan(100);
		expect(sets).toBeGreaterThan(kept * 2);
	});
});
