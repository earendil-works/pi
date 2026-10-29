import { describe, expect, it } from "vitest";
import {
	apply,
	applyImmutable,
	applyImmutableBatches,
	type JsonValue,
	type Op,
	PathError,
	track,
	UnsafePathError,
} from "../src/delta/index.ts";

function freezeDeep<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeDeep(child);
	return Object.freeze(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("checked immutable operation application", () => {
	it("copies each touched container once while preserving input and payload ownership", () => {
		const shared = freezeDeep({ nested: { value: 1 } });
		const untouched = freezeDeep({ value: 9 });
		const rowPayload = freezeDeep({ id: 4, label: "placed" });
		const base = freezeDeep({
			text: "abcdef",
			stable: { value: 7 },
			branch: { value: 1 },
			copy: null as { value: number } | null,
			placed: null as typeof shared | null,
			untouched: null as typeof untouched | null,
			left: null as typeof shared | null,
			right: null as typeof shared | null,
			meta: { count: 0, obsolete: true },
			rows: [
				{ id: 1, label: "one" },
				{ id: 2, label: "two" },
				{ id: 3, label: "three" },
			],
		});
		const operations = freezeDeep([
			["t", ["text"], 2],
			["a", ["text"], "!"],
			["s", ["meta", "count"], 1],
			["s", ["meta", "count"], 2],
			["d", ["meta", "obsolete"]],
			["s", ["copy"], base.branch],
			["s", ["copy", "value"], 2],
			["s", ["placed"], shared],
			["s", ["placed", "nested", "value"], 2],
			["s", ["untouched"], untouched],
			["s", ["left"], shared],
			["s", ["right"], shared],
			["s", ["left", "nested", "value"], 3],
			["p", ["rows"], 1, 1, [rowPayload]],
			["s", ["rows", 1, "label"], "edited"],
			["m", ["rows"], [1, 0, 2]],
			["s", ["rows", 0, "label"], "moved"],
		] satisfies Op[]);

		const result = applyImmutable(base, operations);
		const mutableResult = apply(clone(base), clone(operations));

		expect(result).toEqual(mutableResult);
		expect(result.text).toBe("cdef!");
		expect(result.stable).toBe(base.stable);
		expect(result.untouched).toBe(untouched);
		expect(result.copy).not.toBe(base.branch);
		expect(result.copy).toEqual({ value: 2 });
		expect(result.placed).not.toBe(shared);
		expect(result.placed).toEqual({ nested: { value: 2 } });
		expect(result.left).not.toBe(shared);
		expect(result.right).toBe(shared);
		expect(result.rows[0]).not.toBe(rowPayload);
		expect(result.rows[0]).toEqual({ id: 4, label: "moved" });
		expect(base.branch.value).toBe(1);
		expect(shared.nested.value).toBe(1);
		expect(rowPayload.label).toBe("placed");
	});

	it("protects root replacement payloads before later object and array edits", () => {
		const replacement = freezeDeep({ nested: { value: 1 }, values: [1, 2, 3] });
		const result = applyImmutableBatches<typeof replacement>(undefined, [
			[["r", replacement]],
			[["s", ["nested", "value"], 2]],
			[
				["p", ["values"], 1, 1, [4, 5]],
				["m", ["values"], [3, 0, 1, 2]],
			],
		]);
		expect(result).toEqual({ nested: { value: 2 }, values: [3, 1, 4, 5] });
		expect(replacement).toEqual({ nested: { value: 1 }, values: [1, 2, 3] });

		const array = freezeDeep([1, 2, 3]);
		const arrayResult = applyImmutable<number[]>(array, [
			["p", [], 1, 1, [4, 5]],
			["m", [], [3, 0, 1, 2]],
			["d", [1]],
		]);
		expect(arrayResult).toEqual([3, 4, 5]);
		expect(array).toEqual([1, 2, 3]);
	});

	it("shares one private copy-on-write scope across batch partitions", () => {
		const base = freezeDeep({
			text: "abcdef",
			meta: { count: 0 },
			values: [
				{ id: 1, value: 1 },
				{ id: 2, value: 2 },
				{ id: 3, value: 3 },
			],
		});
		const batches = [
			[
				["s", ["meta", "count"], 1],
				["p", ["values"], 1, 1, [{ id: 4, value: 4 }]],
			] satisfies Op[],
			[] satisfies Op[],
			[
				["m", ["values"], [2, 0, 1]],
				["s", ["values", 2, "value"], 40],
			] satisfies Op[],
			[
				["t", ["text"], 2],
				["a", ["text"], "!"],
			] satisfies Op[],
		];

		const intermediate = applyImmutable(base, batches[0]);
		const intermediateSnapshot = clone(intermediate);
		let sequential = intermediate;
		for (let index = 1; index < batches.length; index++) sequential = applyImmutable(sequential, batches[index]!);
		const streamed = applyImmutableBatches(base, batches);
		const flattened = applyImmutable(base, batches.flat());

		expect(streamed).toEqual(sequential);
		expect(streamed).toEqual(flattened);
		expect(intermediate).toEqual(intermediateSnapshot);
		expect(base.meta.count).toBe(0);
		expect(base.values[1]!.id).toBe(2);
	});

	it("handles tracker-produced batches across arbitrary revision boundaries", () => {
		type Document = { text: string; values: { id: number; score: number }[]; revision: number };
		const initial: Document = {
			text: "start",
			values: Array.from({ length: 8 }, (_, id) => ({ id, score: 0 })),
			revision: 0,
		};
		const tracker = track(initial);
		const batches: Array<readonly Op[]> = [];
		for (let revision = 1; revision <= 40; revision++) {
			const change = tracker.beginChange();
			change.state.revision = revision;
			change.state.text = `${change.state.text.slice(1)}${revision}`;
			switch (revision % 5) {
				case 0:
					change.state.values.reverse();
					break;
				case 1:
					change.state.values.push({ id: 100 + revision, score: revision });
					break;
				case 2:
					change.state.values.shift();
					break;
				case 3:
					change.state.values[revision % change.state.values.length]!.score = revision;
					break;
				default:
					change.state.values.splice(1, 1, { id: 200 + revision, score: revision });
			}
			const prepared = change.prepare();
			batches.push(prepared.ops);
			tracker.adopt(prepared);
		}

		expect(applyImmutableBatches(initial, batches)).toEqual(tracker.value);
	});

	it("does not expose partial application when validation or iteration fails", () => {
		const base = freezeDeep({ nested: { value: 1 } });
		const invalidBatches: readonly (readonly Op[])[] = [
			[["s", ["nested", "value"], 2]],
			[["s", ["constructor", "prototype", "polluted"], true]],
		];
		expect(() => applyImmutableBatches(base, invalidBatches)).toThrow();
		expect(base.nested.value).toBe(1);
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

		function* throwingBatches(): Generator<readonly Op[]> {
			yield [["s", ["nested", "value"], 3]];
			throw new Error("revision stream failed");
		}
		expect(() => applyImmutableBatches(base, throwingBatches())).toThrow("revision stream failed");
		expect(base.nested.value).toBe(1);

		let advancedPastInvalid = false;
		let iteratorClosed = false;
		function* invalidOperationBatches(): Generator<readonly Op[]> {
			try {
				yield [["s", ["nested", "value"], 4]];
				yield [["s", ["__proto__", "polluted"], true]];
				advancedPastInvalid = true;
			} finally {
				iteratorClosed = true;
			}
		}
		expect(() => applyImmutableBatches(base, invalidOperationBatches())).toThrow(UnsafePathError);
		expect(advancedPastInvalid).toBe(false);
		expect(iteratorClosed).toBe(true);
		expect(base.nested.value).toBe(1);

		let reads = 0;
		const target = Object.defineProperty({}, "trap", {
			enumerable: true,
			get() {
				reads++;
				return {};
			},
		});
		const malformed: Op[] = [["s", "bad-path", 1] as never];
		expect(() => applyImmutableBatches(target, [malformed])).toThrow(/path/);
		expect(reads).toBe(0);

		expect(() => applyImmutable({ values: [] }, [["s", ["values", "missing", "value"], 1]])).toThrow(PathError);
		expect(() => applyImmutable({ values: [{}] }, [["s", ["values", "0", "value"], 1]])).toThrow(UnsafePathError);
	});

	it("allows one immutable batch to fan out without mutating shared payloads", () => {
		const payload = freezeDeep({ nested: { value: 1 } });
		const operations: readonly Op[] = [
			["s", ["placed"], payload],
			["s", ["placed", "nested", "value"], 2],
		];
		const base = freezeDeep({ placed: null as typeof payload | null });
		const first = applyImmutable(base, operations);
		const second = applyImmutable(base, operations);
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(first.placed).not.toBe(second.placed);
		expect(payload.nested.value).toBe(1);
	});
});

describe("immutable container copies", () => {
	it("keep an own __proto__ member as data and the prototype of the copied object", () => {
		const plain = JSON.parse('{"__proto__":{"polluted":true},"n":1}') as Record<string, JsonValue>;
		const bare = Object.assign(Object.create(null) as Record<string, JsonValue>, { n: 1 });
		for (const base of [plain, bare]) {
			const checked = applyImmutable(base, [["s", ["n"], 2]]);
			// Tracker revisions copy through the trusted path.
			const tracker = track(base);
			const change = tracker.beginChange();
			change.state.n = 2;
			tracker.adopt(change.prepare());
			for (const copy of [checked, tracker.value]) {
				expect(copy).not.toBe(base);
				expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(base));
				expect(Object.keys(copy)).toEqual(Object.keys(base));
				expect(copy.n).toBe(2);
				if (base === plain)
					expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value).toEqual({ polluted: true });
			}
		}
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});
});

describe("immutable application complexity", () => {
	it("appends to an array not yet copied in one copy, sharing everything else", () => {
		const entries = Array.from({ length: 1_000 }, (_, index) => ({ index }));
		const base = freezeDeep({ log: { entries, meta: { count: 1_000 } }, other: { value: 1 } });
		const result = applyImmutable(base, [
			["p", ["log", "entries"], 1_000, 0, [{ index: 1_000 }]],
			["p", ["log", "entries"], 1_001, 0, [{ index: 1_001 }]],
		]);
		expect(result.log.entries).toHaveLength(1_002);
		expect(result.log.entries.slice(-2)).toEqual([{ index: 1_000 }, { index: 1_001 }]);
		expect(base.log.entries).toHaveLength(1_000);
		expect(result.log.entries[0]).toBe(entries[0]);
		expect(result.log.meta).toBe(base.log.meta);
		expect(result.other).toBe(base.other);
		expect(result.log).not.toBe(base.log);

		const rootArray = freezeDeep([1, 2]);
		expect(applyImmutable(rootArray, [["p", [], 2, 0, [3]]])).toEqual([1, 2, 3]);
		expect(rootArray).toEqual([1, 2]);
		// An appended item that is itself an array stays one element.
		expect(applyImmutable(rootArray, [["p", [], 2, 0, [[3, 4]]]])).toEqual([1, 2, [3, 4]]);
		// Invalid paths fail with the general path's errors.
		const invalid: [Op, typeof PathError | typeof UnsafePathError][] = [
			[["p", ["values", "missing"], 0, 0, []], PathError],
			[["p", ["missing"], 0, 0, []], PathError],
			[["p", ["values", 0], 0, 0, []], PathError],
			[["p", ["__proto__"], 0, 0, []], UnsafePathError],
			[["p", ["list", "x"], 0, 0, []], PathError],
			[["p", ["text"], 0, 0, []], PathError],
			[["p", ["list", -1], 0, 0, []], UnsafePathError],
			[["p", ["list", 1.5], 0, 0, []], UnsafePathError],
			[["p", ["list", 0, "constructor"], 0, 0, []], UnsafePathError],
		];
		const document = freezeDeep({ values: [] as JsonValue[], list: [[1]], text: "a" });
		for (const [op, error] of invalid)
			expect(() => applyImmutable(document, [op]), JSON.stringify(op)).toThrow(error);
		// An insert that is not at the end takes the general path.
		expect(applyImmutable(rootArray, [["p", [], 1, 0, [9]]])).toEqual([1, 9, 2]);
	});

	it("copies a wide object once rather than once per repeated write", () => {
		const width = 20_000;
		const base: Record<string, JsonValue> = {};
		for (let index = 0; index < width; index++) base[`field${index}`] = index;
		const operations: Op[] = Array.from({ length: 1_000 }, (_, index): Op => ["s", [`field${index}`], -index]);
		// A copy lists the object's keys; the proxy counts the listings.
		let shallowCopies = 0;
		const counted = new Proxy(base, {
			ownKeys(target) {
				shallowCopies++;
				return Reflect.ownKeys(target);
			},
		});
		const result = applyImmutable(counted, operations);

		expect(result.field999).toBe(-999);
		expect(base.field999).toBe(999);
		expect(shallowCopies).toBe(1);
	});
});
