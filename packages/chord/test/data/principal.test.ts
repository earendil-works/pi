import { GCProfiler, getHeapStatistics } from "node:v8";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import {
	canonicalJson,
	copyPlainJson,
	principalJson,
	principalKey,
	samePlainJson,
	samePrincipal,
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

describe("samePlainJson and copyPlainJson", () => {
	const text = (value: unknown) => canonicalJson(value as never, BACKGROUND_CONTEXT);
	/** Whether `value` is plain JSON: whether it has a plain copy. */
	const isPlainJson = (value: unknown) => copyPlainJson(value) !== undefined;

	/** A random value of few distinct parts; with `odd`, what plugin code may hand over as JSON too. */
	function random(next: () => number, depth: number, odd: boolean): unknown {
		const plainTokens = [0, -0, 1, "a", "", true, false, null, "b"];
		const oddTokens = [Number.NaN, Number.POSITIVE_INFINITY, undefined, Symbol("s"), () => {}, new Date(0)];
		const tokens = odd ? [...plainTokens, ...oddTokens] : plainTokens;
		const pick = Math.floor(next() * (tokens.length + (depth > 2 ? 0 : 2)));
		if (pick < tokens.length) return tokens[pick];
		if (pick === tokens.length)
			return Array.from({ length: Math.floor(next() * 3) }, () => random(next, depth + 1, odd));
		const object: Record<string, unknown> = next() < 0.8 ? {} : Object.create(null);
		for (const key of ["a", "b", "granted"]) if (next() < 0.5) object[key] = random(next, depth + 1, odd);
		if (next() < 0.2) Object.defineProperty(object, "hidden", { value: 1, enumerable: false });
		return object;
	}

	/** `value` built again: other objects, keys in another order, each part maybe one with the same text. */
	function remix(value: unknown, next: () => number): unknown {
		if (Object.is(value, 0) || Object.is(value, -0)) return next() < 0.5 ? 0 : -0;
		if (value === null && next() < 0.3) return Number.NaN;
		if (Array.isArray(value)) {
			if (value.length === 0 && next() < 0.3) return [undefined];
			return value.map((item) => remix(item, next));
		}
		if (typeof value !== "object" || value === null) return value;
		const fields = value as Record<string, unknown>;
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(fields).sort(() => next() - 0.5)) {
			copy[key] = next() < 0.2 ? fields[key] : remix(fields[key], next);
		}
		return copy;
	}

	it("says what canonical JSON says for a plain value against any other; odd for one that is no plain JSON", () => {
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
		// A plain object (a date is no plain JSON, whatever its fields).
		const object = (value: unknown) =>
			typeof value === "object" &&
			value !== null &&
			[Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
			!Array.isArray(value);
		const found = { equal: 0, different: 0, odd: 0 };
		for (let round = 0; round < 20_000; round++) {
			const a = random(next, 0, false);
			const b = next() < 0.6 ? remix(a, next) : random(next, 0, next() < 0.5);
			expect(isPlainJson(a)).toBe(true);
			const same = text(a) === text(b);
			const result = samePlainJson(a, b);
			found[result]++;
			// Equal is always exact; for a plain value so is different; odd only for a value that is not plain.
			if (result === "equal") expect([round, same]).toEqual([round, true]);
			if (isPlainJson(b)) expect([round, result]).toEqual([round, same ? "equal" : "different"]);
			else expect([round, result]).not.toEqual([round, "equal"]);
			if (object(a) && object(b) && isPlainJson(omit(b))) {
				const skipped = text(omit(a)) === text(omit(b));
				expect([round, samePlainJson(a, b, "granted")]).toEqual([round, skipped ? "equal" : "different"]);
			}
		}
		// Every answer is common: the test compares many equal values.
		expect(Math.min(found.equal, found.different, found.odd)).toBeGreaterThan(1_000);
	});

	it("is odd for what is no plain JSON: no finite number, no JSON, an exotic prototype, a hole, past its bounds", () => {
		class Point {
			x = 1;
		}
		const deep = (depth: number) => {
			let value: unknown = 0;
			for (let level = 0; level < depth; level++) value = { x: value };
			return value;
		};
		const odd = [
			Number.NaN,
			Number.NEGATIVE_INFINITY,
			undefined,
			Symbol("s"),
			() => {},
			1n,
			new Date(0),
			new Point(),
			new (class extends Array {})(),
			[, 1],
			// Canonical JSON calls a list's `entries`: an own one is no plain list.
			Object.assign([1], { entries: 0 }),
			{ toJSON: () => 1 },
			deep(17),
			Array.from({ length: 256 }, () => 1),
		];
		// Never equal to a plain value; odd as soon as the comparison meets it, or different before.
		expect(odd.map((value) => [isPlainJson(value), samePlainJson({ a: 1 }, { a: value }) === "equal"])).toEqual(
			odd.map(() => [false, false]),
		);
		expect(odd.slice(0, 6).map((value) => samePlainJson({ a: 1 }, { a: value }))).toEqual(
			odd.slice(0, 6).map(() => "odd"),
		);
		expect([isPlainJson(deep(15)), isPlainJson(Array.from({ length: 255 }, () => 1))]).toEqual([true, true]);
		expect([
			samePlainJson(deep(15), deep(15)),
			samePlainJson([0], [-0]),
			samePlainJson({ a: 1, b: 2 }, { b: 2, a: 1 }),
		]).toEqual(["equal", "equal", "equal"]);
	});

	it("copies plain JSON as Chord's own: other objects, an own __proto__ key kept, later changes not seen", () => {
		const value = JSON.parse('{"__proto__":1,"list":[{"n":-0}],"o":{"x":"y"}}');
		const copy = copyPlainJson(value) as { list: { n: number }[]; o: object };
		expect([copy === value, copy.list === value.list, copy.o === value.o]).toEqual([false, false, false]);
		expect([Object.keys(copy), samePlainJson(copy, value)]).toEqual([["__proto__", "list", "o"], "equal"]);
		value.list[0].n = 1;
		expect([copy.list[0]!.n, samePlainJson(copy, value)]).toEqual([-0, "different"]);
	});

	it("calls no code: a toJSON or getter of the kept value is never run again", () => {
		let rendered = 0;
		const kept = { x: 1 };
		const later = { x: Object.assign(() => {}, { toJSON: () => ++rendered }) };
		expect([samePlainJson(kept, later), rendered]).toEqual(["odd", 0]);
	});

	it("makes no text for equal values of other objects (cost guard)", () => {
		const a = { mode: "write", level: 3, tags: ["x", "y"], nested: { on: true, at: [1, 2, 3] } };
		const b = { nested: { at: [1, 2, 3], on: true }, tags: ["x", "y"], level: 3, mode: "write" };
		for (let warm = 0; warm < 1_000; warm++) samePlainJson(a, b);
		const profiler = new GCProfiler();
		profiler.start();
		const before = getHeapStatistics().used_heap_size;
		let equal = 0;
		for (let round = 0; round < 10_000; round++) if (samePlainJson(a, b, "granted") === "equal") equal++;
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
