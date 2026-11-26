import { GCProfiler, getHeapStatistics } from "node:v8";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import {
	canonicalJson,
	principalJson,
	principalKey,
	sameJson,
	samePrincipal,
	walkJson,
} from "../../src/data/internal.ts";
import { counted, expectCollected, metered } from "../support.ts";

describe("canonicalJson", () => {
	it("sorts object keys and writes -0 as 0", () => {
		expect(canonicalJson({ b: 1, a: [{ d: -0, c: null }] }, BACKGROUND_CONTEXT)).toBe(
			'{"a":[{"c":null,"d":0}],"b":1}',
		);
		expect(canonicalJson("x", BACKGROUND_CONTEXT)).toBe('"x"');
	});

	it("writes what is no JSON as JSON.stringify does in a list (nothing) and as its text in an object", () => {
		// Plugin code hands values the types call JSON: the text is what it always was for them.
		const odd = { list: [1, undefined, null, [undefined]], gone: undefined, nan: Number.NaN } as never;
		expect(canonicalJson(odd, BACKGROUND_CONTEXT)).toBe('{"gone":undefined,"list":[1,,null,[]],"nan":null}');
		expect(canonicalJson([], BACKGROUND_CONTEXT)).toBe("[]");
		expect(canonicalJson({}, BACKGROUND_CONTEXT)).toBe("{}");
		expect(canonicalJson(null, BACKGROUND_CONTEXT)).toBe("null");
	});

	it("counts one walk", async () => {
		expect(await counted((context) => canonicalJson({ a: [1, 2] }, context))).toEqual({
			walks: 1,
			validations: 0,
			compilations: 0,
		});
	});
});

describe("sameJson", () => {
	const text = (value: unknown) => canonicalJson(value as never, BACKGROUND_CONTEXT);

	/** A random value of few distinct parts, odd ones included (what plugin code may hand over as JSON). */
	function random(next: () => number, depth: number): unknown {
		const pick = Math.floor(next() * (depth > 2 ? 14 : 17));
		const tokens = [0, -0, 1, "a", "", true, false, null, Number.NaN, Number.POSITIVE_INFINITY, undefined];
		if (pick < tokens.length) return tokens[pick];
		if (pick === 11) return Symbol("s");
		if (pick === 12) return () => {};
		if (pick === 13) return "b";
		if (pick === 14) return Array.from({ length: Math.floor(next() * 3) }, () => random(next, depth + 1));
		const object: Record<string, unknown> = pick === 15 ? {} : Object.create(null);
		for (const key of ["a", "b", "granted"]) if (next() < 0.5) object[key] = random(next, depth + 1);
		if (next() < 0.2) Object.defineProperty(object, "hidden", { value: 1, enumerable: false });
		return object;
	}

	/** `value` built again: other objects, keys in another order, each part maybe one with the same text. */
	function remix(value: unknown, next: () => number): unknown {
		const same: unknown[][] = [
			[0, -0],
			[null, Number.NaN, Number.NEGATIVE_INFINITY],
			[undefined, Symbol("t")],
		];
		const group = same.find((members) => members.some((member) => Object.is(member, value)));
		if (group !== undefined) return group[Math.floor(next() * group.length)];
		if (Array.isArray(value)) {
			if (value.length === 0 && next() < 0.3) return [undefined];
			return value.map((item) => remix(item, next));
		}
		if (typeof value !== "object" || value === null) return value;
		const keys = Object.keys(value).sort(() => next() - 0.5);
		const copy: Record<string, unknown> = {};
		for (const key of keys)
			copy[key] =
				next() < 0.2
					? (value as Record<string, unknown>)[key]
					: remix((value as Record<string, unknown>)[key], next);
		return copy;
	}

	it("says what equal canonical JSON says, for random values and their remixes, with and without a skipped key", () => {
		let seed = 7;
		const next = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const omit = (value: unknown) => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
			const { granted: _, ...rest } = value as Record<string, unknown>;
			return rest;
		};
		let equal = 0;
		for (let round = 0; round < 20_000; round++) {
			const a = random(next, 0);
			const b = next() < 0.6 ? remix(a, next) : random(next, 0);
			const same = text(a) === text(b);
			expect([round, sameJson(a, b)]).toEqual([round, same]);
			if (same) equal++;
			const object = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
			const skipped = object(a) && object(b) ? text(omit(a)) === text(omit(b)) : same;
			expect([round, sameJson(a, b, "granted")]).toEqual([round, skipped]);
		}
		// Both answers are common: the test compares many equal values.
		expect(equal).toBeGreaterThan(5_000);
	});

	it("throws where canonical JSON throws (a bigint); compares a function by what JSON.stringify makes of it", () => {
		expect(() => sameJson({ a: 1 }, { a: 1n })).toThrow("BigInt");
		expect(() => walkJson({ a: [1n] })).toThrow("BigInt");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => walkJson(cyclic)).toThrow(RangeError);
		const json = Object.assign(() => {}, { toJSON: () => 5 });
		expect([sameJson({ a: 5 }, { a: json }), sameJson([undefined], [() => {}]), sameJson([], [json])]).toEqual([
			true,
			true,
			false,
		]);
	});

	it("makes no text for equal values of other objects (cost guard)", () => {
		const a = { mode: "write", level: 3, tags: ["x", "y"], nested: { on: true, at: [1, 2, 3] } };
		const b = { nested: { at: [1, 2, 3], on: true }, tags: ["x", "y"], level: 3, mode: "write" };
		for (let warm = 0; warm < 1_000; warm++) sameJson(a, b);
		const profiler = new GCProfiler();
		profiler.start();
		const before = getHeapStatistics().used_heap_size;
		let equal = 0;
		for (let round = 0; round < 10_000; round++) if (sameJson(a, b, "granted")) equal++;
		const after = getHeapStatistics().used_heap_size;
		let freed = 0;
		for (const collection of profiler.stop().statistics) {
			freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
		}
		expect(equal).toBe(10_000);
		// Measured about 50 B per comparison (V8's for-in over an object's keys), 7.5 KiB for two canonical texts.
		expect(after - before + freed).toBeLessThan(10_000 * 500);
	});
});

describe("principalKey", () => {
	it("defaults to the canonical JSON, whatever the property order", () => {
		expect(principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT)).toBe('{"id":"u1","kind":"user"}');
		expect(principalKey({ id: "u1", kind: "user" }, BACKGROUND_CONTEXT)).toBe(
			principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT),
		);
	});

	it("uses a custom key function when given", () => {
		const byId = (principal: { kind: string; id: string }) => `${principal.kind}:${principal.id}`;
		expect(principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT, byId)).toBe("user:u1");
	});

	it("caches per principal object: no second walk", async () => {
		const principal = { kind: "user", id: "u1" };
		const first = await counted((context) => principalKey(principal, context));
		const second = await counted((context) => principalKey(principal, context));
		expect([first.walks, second.walks]).toEqual([1, 0]);
	});

	it("caches custom keys per function", () => {
		const principal = { kind: "user", id: "u1" };
		let calls = 0;
		const custom = () => `key${++calls}`;
		expect([
			principalKey(principal, BACKGROUND_CONTEXT, custom),
			principalKey(principal, BACKGROUND_CONTEXT, custom),
		]).toEqual(["key1", "key1"]);
		expect(principalKey(principal, BACKGROUND_CONTEXT, () => "other")).toBe("other");
		expect(principalKey(principal, BACKGROUND_CONTEXT)).toBe('{"id":"u1","kind":"user"}');
	});

	it("never retains a dropped custom key function while its principal lives", async () => {
		const principal = { kind: "user", id: "u1" };
		const ref = (() => {
			const custom = () => "k";
			principalKey(principal, BACKGROUND_CONTEXT, custom);
			return new WeakRef(custom);
		})();
		await expectCollected(ref);
		expect(principalKey(principal, BACKGROUND_CONTEXT)).toBeTypeOf("string");
	});

	it("does not retain dropped principals", async () => {
		const ref = (() => {
			const principal = { kind: "user", id: "gone" };
			principalKey(principal, BACKGROUND_CONTEXT);
			principalKey(principal, BACKGROUND_CONTEXT, () => "k");
			return new WeakRef(principal);
		})();
		await expectCollected(ref);
	});
});

describe("samePrincipal", () => {
	const ada = { kind: "user", id: "u1" };

	it("matches the same canonical JSON, whatever the property order; nothing else", () => {
		expect(samePrincipal({ id: "u1", kind: "user" }, ada, BACKGROUND_CONTEXT)).toBe(true);
		expect(samePrincipal({ ...ada, name: "Ada" }, ada, BACKGROUND_CONTEXT)).toBe(false);
		expect(samePrincipal({ kind: "guest", id: "u1" }, ada, BACKGROUND_CONTEXT)).toBe(false);
		expect(samePrincipal(undefined, ada, BACKGROUND_CONTEXT)).toBe(false);
	});

	it("computes each principal's key once (cost guard)", async () => {
		const owner = { kind: "user", id: "owner" };
		const { context, counts } = await metered();
		const caller = { kind: "user", id: "owner" };
		samePrincipal(caller, owner, context);
		samePrincipal(caller, owner, context);
		expect(counts()["chord.data.walks"]).toBe(2);
		samePrincipal({ kind: "user", id: "owner" }, owner, context);
		expect(counts()["chord.data.walks"]).toBe(3);
	});
});

describe("principalJson", () => {
	it("is the principal's own JSON, its fields in insertion order: equal only when they serialize equally", () => {
		expect(principalJson({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT)).toBe('{"kind":"user","id":"u1"}');
		expect(principalJson({ id: "u1", kind: "user" }, BACKGROUND_CONTEXT)).not.toBe(
			principalJson({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT),
		);
		expect(principalJson({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT)).toBe(
			principalJson({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT),
		);
	});

	it("caches per principal object: one walk per object (cost guard)", async () => {
		const { context, counts } = await metered();
		const principal = { kind: "user", id: "u1" };
		principalJson(principal, context);
		principalJson(principal, context);
		expect(counts()["chord.data.walks"]).toBe(1);
		principalJson({ kind: "user", id: "u1" }, context);
		expect(counts()["chord.data.walks"]).toBe(2);
	});

	it("does not retain dropped principals", async () => {
		const ref = (() => {
			const principal = { kind: "user", id: "dropped" };
			principalJson(principal, BACKGROUND_CONTEXT);
			return new WeakRef(principal);
		})();
		await expectCollected(ref);
	});
});
