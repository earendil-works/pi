import { isProxy } from "node:util/types";
import { describe, expect, it } from "vitest";
import { apply, type Draft, decoder, encoder, type JsonValue, type Op, track } from "../../src/delta/index.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function replay<T>(base: T, operations: readonly Op[]): T {
	return apply(clone(base), clone(operations));
}

function expectAliasFree(value: unknown): void {
	const seen = new WeakMap<object, string>();
	const visit = (current: unknown, path: string): void => {
		if (current === null || typeof current !== "object") return;
		const previous = seen.get(current);
		if (previous !== undefined) throw new Error(`container at ${path} aliases ${previous}`);
		seen.set(current, path);
		if (Array.isArray(current)) {
			for (let index = 0; index < current.length; index++) visit(current[index], `${path}[${index}]`);
			return;
		}
		for (const key of Object.keys(current)) visit((current as Record<string, unknown>)[key], `${path}.${key}`);
	};
	visit(value, "$root");
}

function settle<T extends object>(tracker: ReturnType<typeof track<T>>, mutate: (draft: Draft<T>) => void): T {
	const baseRoot = tracker.value;
	const base = clone(baseRoot);
	const change = tracker.beginChange();
	mutate(change.state);
	const prepared = change.prepare();
	const candidate = clone(prepared.value);
	expect(isProxy(prepared.value)).toBe(false);
	expect(replay(base, prepared.ops)).toEqual(candidate);
	expect(baseRoot).toEqual(base);
	tracker.adopt(prepared);
	expect(baseRoot).toEqual(base);
	expect(tracker.value).toBe(prepared.value);
	expect(tracker.value).toEqual(candidate);
	return candidate;
}

describe("delta tracker transactional overlay lifecycle", () => {
	it("materializes an immutable next revision and adopts it by pointer swap", () => {
		const initial = { count: 1, nested: { text: "a" }, values: [1] };
		const tracker = track(initial);
		expect(tracker.value).toBe(initial);
		const change = tracker.beginChange();
		change.state.count = 2;
		change.state.nested.text += "b";
		change.state.values.push(2);
		expect(initial).toEqual({ count: 1, nested: { text: "a" }, values: [1] });
		const prepared = change.prepare();
		const next = prepared.value;
		expect(prepared.baseRevision).toBe(0);
		expect(prepared.base).toBe(initial);
		expect(next).not.toBe(initial);
		expect(isProxy(next)).toBe(false);
		expect(next).toEqual({ count: 2, nested: { text: "ab" }, values: [1, 2] });
		expect(prepared.ops).toEqual([
			["s", ["count"], 2],
			["a", ["nested", "text"], "b"],
			["p", ["values"], 1, 0, [2]],
		]);
		expect(tracker.value).toBe(initial);
		tracker.adopt(prepared);
		expect(initial).toEqual({ count: 1, nested: { text: "a" }, values: [1] });
		expect(tracker.value).toBe(next);
		expect(prepared.value).toBe(next);
		expect(prepared.base).toBe(initial);
		expect(() => change.state.count).toThrow(TypeError);
	});

	it("keeps a transaction live across await and seals it only at prepare", async () => {
		const tracker = track({ left: 0, nested: { right: 0 } });
		const change = tracker.beginChange();
		change.state.left = 1;
		await Promise.resolve();
		change.state.nested.right = 2;
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ left: 1, nested: { right: 2 } });
		expect(() => {
			change.state.left = 3;
		}).toThrow(/settled/);
		tracker.adopt(prepared);
	});

	it("allows Promise resolution to inspect a settled draft without reporting a false failure", async () => {
		const initial = JSON.parse('{"then":"document-value","value":1}') as { then: string; value: number };
		const tracker = track(initial);
		const change = tracker.beginChange();
		const draft = change.state;
		expect(draft.then).toBe("document-value");
		draft.value = 2;
		const prepared = change.prepare();

		const resolved = await Promise.resolve(draft);
		expect(resolved).toBe(draft);
		expect(resolved.then).toBeUndefined();
		expect(() => resolved.value).toThrow(/settled/);

		tracker.adopt(prepared);
		expect(tracker.value.then).toBe("document-value");
		expect(tracker.value.value).toBe(2);

		const largeTracker = track({ rows: Array.from({ length: 4_100 }, (_, value) => ({ value })) });
		const largeChange = largeTracker.beginChange();
		const largeDraft = largeChange.state;
		for (const row of largeDraft.rows) expect(row.value).toBeGreaterThanOrEqual(0);
		largeDraft.rows[0]!.value = -1;
		const largePrepared = largeChange.prepare();
		expect(await Promise.resolve(largeDraft)).toBe(largeDraft);
		expect(() => largeDraft.rows).toThrow(/settled/);
		largeTracker.adopt(largePrepared);
	});

	it("aborts idempotently and revokes held descendants", () => {
		const tracker = track({ child: { value: 1 } });
		const change = tracker.beginChange();
		const child = change.state.child;
		child.value = 2;
		change.abort();
		change.abort();
		expect(tracker.value.child.value).toBe(1);
		expect(() => child.value).toThrow(TypeError);
		expect(() => change.prepare()).toThrow(/settled/);
	});

	it("allows competing contexts and invalidates loser views", () => {
		const tracker = track({ value: 0 });
		const first = tracker.beginChange();
		const second = tracker.beginChange();
		first.state.value = 1;
		second.state.value = 2;
		const firstPrepared = first.prepare();
		const secondPrepared = second.prepare();
		const held = secondPrepared.value;
		tracker.adopt(firstPrepared);
		expect(tracker.value.value).toBe(1);
		expect(held.value).toBe(2);
		expect(() => tracker.adopt(secondPrepared)).toThrow(/stale/);
		expect(() => tracker.adopt(firstPrepared)).toThrow(/already been used/);
	});

	it("invalidates competing open overlays without changing their base revision", () => {
		const initial = { rows: [{ value: 0 }, { value: 1 }] };
		const tracker = track(initial);
		const staleChange = tracker.beginChange();
		const held = staleChange.state.rows[1]!;
		held.value = 2;

		const winner = tracker.beginChange();
		winner.state.rows[0]!.value = 3;
		const prepared = winner.prepare();
		tracker.adopt(prepared);

		expect(initial).toEqual({ rows: [{ value: 0 }, { value: 1 }] });
		expect(tracker.value).toEqual({ rows: [{ value: 3 }, { value: 1 }] });
		expect(() => held.value).toThrow(/settled/);
		expect(() => staleChange.prepare()).toThrow(/settled/);
		staleChange.abort();
	});

	it("adopts object edits as ordinary fast-layout immutable revisions", () => {
		const initial = { first: 1, second: 2 } as { first: number; second?: number; third?: number };
		const tracker = track(initial);
		const change = tracker.beginChange();
		change.state.first = 3;
		delete change.state.second;
		change.state.third = 4;
		const prepared = change.prepare();
		tracker.adopt(prepared);
		expect(tracker.value).not.toBe(initial);
		expect(initial).toEqual({ first: 1, second: 2 });
		expect(tracker.value).toEqual({ first: 3, third: 4 });
		expect(Object.getOwnPropertyDescriptor(tracker.value, "third")).toEqual({
			value: 4,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	});

	it("supports adopt-then-publish ordering and retained publication reads", () => {
		const tracker = track({ value: 0, nested: { count: 0 } });
		const change = tracker.beginChange();
		change.state.value = 1;
		change.state.nested.count = 1;
		const prepared = change.prepare();
		const operations = prepared.ops;
		tracker.adopt(prepared);
		// Matches services/state.ts: adopt first, then inspect ops and publish prepared.value.
		expect(prepared.ops).toBe(operations);
		const published = prepared.ops.length === 0 ? undefined : prepared.value;
		expect(operations).toHaveLength(2);
		expect(published).toBeDefined();
		expect(published).toBe(tracker.value);
		expect(clone(published!)).toEqual({ value: 1, nested: { count: 1 } });

		const next = tracker.beginChange();
		next.state.value = 2;
		const nextPrepared = next.prepare();
		tracker.adopt(nextPrepared);
		// Retained immutable publications remain at their original revision.
		expect(published).not.toBe(tracker.value);
		expect(prepared.value).toEqual({ value: 1, nested: { count: 1 } });
		expect(tracker.value).toEqual({ value: 2, nested: { count: 1 } });
	});

	it("keeps replacement base/value structurally compatible and readable after adoption", () => {
		const original = { value: 0 };
		const replacement = { value: 1 };
		const tracker = track(original);
		const prepared = tracker.prepareReplace(replacement);
		expect(prepared.base).toBe(original);
		expect(prepared.value).toBe(replacement);
		tracker.adopt(prepared);
		expect(prepared.base).toBe(original);
		expect(prepared.value).toBe(replacement);
		expect(prepared.value).toBe(tracker.value);
	});

	it("keeps aborted and stale materialized candidates readable", () => {
		const tracker = track({ value: 0 });
		const abortedChange = tracker.beginChange();
		abortedChange.state.value = 1;
		const aborted = abortedChange.prepare();
		const abortedView = aborted.value;
		aborted.abort();
		expect(abortedView.value).toBe(1);
		expect(aborted.value.value).toBe(1);

		const loserChange = tracker.beginChange();
		loserChange.state.value = 2;
		const loser = loserChange.prepare();
		const loserView = loser.value;
		const winner = tracker.prepareReplace({ value: 3 });
		tracker.adopt(winner);
		expect(loserView.value).toBe(2);
		expect(loser.value.value).toBe(2);
	});

	it("lets a settled Change abort its prepared result without retaining its context", () => {
		const tracker = track({ value: 0, nested: { value: 1 } });
		const change = tracker.beginChange();
		change.state.value = 1;
		const prepared = change.prepare();
		const operations = prepared.ops;
		change.abort();
		change.abort();
		expect(prepared.ops).toBe(operations);
		expect(prepared.value).toEqual({ value: 1, nested: { value: 1 } });
		expect(() => tracker.adopt(prepared)).toThrow(/aborted/);
	});

	it("rejects foreign and aborted prepared values", () => {
		const first = track({ value: 0 });
		const second = track({ value: 0 });
		const prepared = first.prepareReplace({ value: 1 });
		expect(() => second.adopt(prepared)).toThrow(/different tracker/);
		prepared.abort();
		prepared.abort();
		expect(() => first.adopt(prepared)).toThrow(/aborted/);
	});

	it("reads deleted own properties as absent", () => {
		Object.defineProperty(Object.prototype, "trackerInherited", {
			value: 7,
			writable: true,
			configurable: true,
		});
		try {
			const tracker = track({ value: 1 } as { value?: number; trackerInherited?: number });
			const change = tracker.beginChange();
			delete change.state.value;
			change.state.trackerInherited = 1;
			delete change.state.trackerInherited;
			expect(change.state.value).toBeUndefined();
			expect(change.state.trackerInherited).toBeUndefined();
			const prepared = change.prepare();
			expect(prepared.value.value).toBeUndefined();
			// Plain committed values expose inherited properties through ordinary
			// JavaScript reads; strict-JSON membership remains own-properties only.
			expect(prepared.value.trackerInherited).toBe(7);
			tracker.adopt(prepared);
			expect(Object.keys(tracker.value)).toEqual([]);
		} finally {
			delete (Object.prototype as Record<string, unknown>).trackerInherited;
		}
	});

	it("detaches old handles for deeply equal object and array assignments before normalizing", () => {
		const initial = {
			object: { nested: { value: 1 } },
			array: [{ value: 1 }],
			rows: [{ value: 1 }],
		};
		const tracker = track(initial);
		const change = tracker.beginChange();
		const oldObject = change.state.object;
		const oldArray = change.state.array;
		const oldRow = change.state.rows[0]!;
		change.state.object = { nested: { value: 1 } };
		change.state.array = [{ value: 1 }];
		change.state.rows[0] = { value: 1 };
		expect(change.state.object).not.toBe(oldObject);
		expect(change.state.array).not.toBe(oldArray);
		expect(change.state.rows[0]).not.toBe(oldRow);
		oldObject.nested.value = 9;
		oldArray[0]!.value = 9;
		oldRow.value = 9;
		expect(change.state).toEqual({
			object: { nested: { value: 1 } },
			array: [{ value: 1 }],
			rows: [{ value: 1 }],
		});
		const prepared = change.prepare();
		expect(prepared.ops).toEqual([]);
		tracker.adopt(prepared);
		expect(tracker.value).toBe(initial);
		expect(tracker.value.object).toBe(initial.object);
		expect(tracker.value.array).toBe(initial.array);
		expect(tracker.value.rows[0]).toBe(initial.rows[0]);
	});

	it("normalizes a deeply equal replacement without changing committed identity", () => {
		const initial = { nested: { value: 1 }, rows: [1, 2, 3] };
		const tracker = track(initial);
		const prepared = tracker.prepareReplace({ nested: { value: 1 }, rows: [1, 2, 3] });
		expect(prepared.ops).toEqual([]);
		tracker.adopt(prepared);
		expect(tracker.value).toBe(initial);
	});

	it("takes O(1) immutable ownership for replacement and its operation payload", () => {
		const tracker = track({ value: 0, rows: [] as { value: number }[] });
		const replacement = { value: 1, rows: [{ value: 2 }] };
		const prepared = tracker.prepareReplace(replacement);
		expect(prepared.base).toBe(tracker.value);
		expect(prepared.value).toBe(replacement);
		const operations = prepared.ops;
		expect(operations).toEqual([["r", replacement]]);
		expect((operations[0] as readonly ["r", typeof replacement])[1]).toBe(replacement);
		tracker.adopt(prepared);
		expect(tracker.value).toBe(replacement);
	});
});

describe("delta tracker policy view", () => {
	it("supports native reads, descriptors, keys, iteration, map, and JSON", () => {
		const tracker = track({ values: [1, 2, 3], object: { a: 1 } as { a: number; b?: number } });
		const change = tracker.beginChange();
		change.state.values.splice(1, 1, 4, 5);
		change.state.object.b = 2;
		expect(Array.isArray(change.state.values)).toBe(true);
		expect(change.state.values.length).toBe(4);
		expect([...change.state.values]).toEqual([1, 4, 5, 3]);
		expect(change.state.values.map((value) => value * 2)).toEqual([2, 8, 10, 6]);
		expect(Object.keys(change.state.values)).toEqual(["0", "1", "2", "3"]);
		expect(Object.getOwnPropertyDescriptor(change.state.values, "2")?.value).toBe(5);
		expect(Object.keys(change.state.object)).toEqual(["a", "b"]);
		expect(JSON.parse(JSON.stringify(change.state))).toEqual({ values: [1, 4, 5, 3], object: { a: 1, b: 2 } });
		change.abort();
	});

	it("keeps document keys distinct from object proxy target fields", () => {
		const tracker = track({
			object: {
				context: 1,
				base: 2,
				parent: 3,
				dirty: 4,
				target: 5,
				proxy: 6,
			},
		});
		const change = tracker.beginChange();
		change.state.object.context = 7;
		change.state.object.proxy = 8;
		expect(Object.keys(change.state.object)).toEqual(["context", "base", "parent", "dirty", "target", "proxy"]);
		const prepared = change.prepare();
		expect(prepared.value.object).toEqual({ context: 7, base: 2, parent: 3, dirty: 4, target: 5, proxy: 8 });
		tracker.adopt(prepared);
	});

	it("keeps native coercion side effects and string operation forms", () => {
		const tracker = track({ text: "abcdefgh", values: [1, 2, 3], marker: 0 });
		const change = tracker.beginChange();
		change.state.text = `${change.state.text.slice(3)}xyz`;
		change.state.values.splice(
			{
				valueOf() {
					change.state.marker = 1;
					return 1;
				},
			} as unknown as number,
			1,
			4,
		);
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ text: "defghxyz", values: [1, 4, 3], marker: 1 });
		expect(prepared.ops).toContainEqual(["t", ["text"], 3]);
		expect(prepared.ops).toContainEqual(["a", ["text"], "xyz"]);
		expect(replay(tracker.value, decoder().decode(encoder().encode(prepared.ops)))).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("emits deletion and supports root arrays", () => {
		const objectTracker = track({ keep: 1, remove: 2 } as { keep: number; remove?: number });
		settle(objectTracker, (draft) => {
			delete draft.remove;
		});
		expect(objectTracker.value).toEqual({ keep: 1 });

		const arrayTracker = track([1, 2, 3]);
		settle(arrayTracker, (draft) => {
			draft.reverse();
			draft.push(4);
		});
		expect(arrayTracker.value).toEqual([3, 2, 1, 4]);
	});

	it("preserves native object key order after delete and re-add", () => {
		const tracker = track({ first: 1, second: 2 } as { first?: number; second: number });
		const change = tracker.beginChange();
		delete change.state.first;
		change.state.first = 1;
		expect(Object.keys(change.state)).toEqual(["second", "first"]);
		const prepared = change.prepare();
		tracker.adopt(prepared);
		expect(Object.keys(tracker.value)).toEqual(["second", "first"]);
	});

	it("orders new integer-like object keys before strings for recipe-visible reads", () => {
		const tracker = track({ object: { label: "x" } as Record<string, string>, first: "" });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		change.state.object["2"] = "two";
		change.state.object["1"] = "one";
		expect(Object.keys(change.state.object)).toEqual(["1", "2", "label"]);
		change.state.first = Object.keys(change.state.object)[0]!;
		const prepared = change.prepare();
		expect(prepared.value.first).toBe("1");
		expect(Object.keys(prepared.value.object)).toEqual(["1", "2", "label"]);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(tracker.value.first).toBe("1");
		expect(Object.keys(tracker.value.object)).toEqual(["1", "2", "label"]);
	});

	it("normalizes deeply equal container assignments before direct candidate materialization", () => {
		const initial = { child: { a: 1, b: 2 }, count: 0 };
		const tracker = track(initial);
		const change = tracker.beginChange();
		change.state.child = { b: 2, a: 1 };
		change.state.count = 1;
		const prepared = change.prepare();
		const replayed = replay(initial, prepared.ops);
		expect(prepared.ops).toEqual([["s", ["count"], 1]]);
		expect(Object.keys(prepared.value.child)).toEqual(["a", "b"]);
		expect(Object.keys(replayed.child)).toEqual(["a", "b"]);
		expect(prepared.value).toEqual(replayed);
		tracker.adopt(prepared);
	});

	it("keeps native integer and string ordering across deletion and re-addition", () => {
		const tracker = track({
			object: { 1: "one", 2: "two", first: "a", second: "b" } as Record<string, string>,
		});
		const change = tracker.beginChange();
		delete change.state.object["2"];
		change.state.object["2"] = "two";
		delete change.state.object.first;
		change.state.object.first = "a";
		change.state.object["3"] = "three";
		change.state.object["0"] = "zero";
		expect(Object.keys(change.state.object)).toEqual(["0", "1", "2", "3", "second", "first"]);
		const prepared = change.prepare();
		expect(Object.keys(prepared.value.object)).toEqual(["0", "1", "2", "3", "second", "first"]);
		tracker.adopt(prepared);
		expect(Object.keys(tracker.value.object)).toEqual(["0", "1", "2", "3", "second", "first"]);
	});

	it("orders integer-like keys on null-prototype objects", () => {
		const object = Object.create(null) as Record<string, string>;
		object.label = "x";
		const tracker = track({ object });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		change.state.object["2"] = "two";
		change.state.object["1"] = "one";
		expect(Object.keys(change.state.object)).toEqual(["1", "2", "label"]);
		const prepared = change.prepare();
		expect(Object.getPrototypeOf(prepared.value.object)).toBeNull();
		expect(Object.keys(prepared.value.object)).toEqual(["1", "2", "label"]);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(Object.getPrototypeOf(tracker.value.object)).toBeNull();
		expect(Object.keys(tracker.value.object)).toEqual(["1", "2", "label"]);
	});

	it("forwards borrowed mutators to ordinary generic array receivers", () => {
		const tracker = track({ values: [1, 2, 3] });
		const change = tracker.beginChange();
		const receiver = [3, 1, 2];
		const push = change.state.values.push;
		const splice = change.state.values.splice;
		const sort = change.state.values.sort;
		const fill = change.state.values.fill;
		const copyWithin = change.state.values.copyWithin;
		expect(Reflect.apply(push, receiver, [4])).toBe(4);
		expect(Reflect.apply(splice, receiver, [1, 1, 5])).toEqual([1]);
		expect(Reflect.apply(sort, receiver, [(left: number, right: number) => left - right])).toBe(receiver);
		expect(Reflect.apply(fill, receiver, [7, 1, 2])).toBe(receiver);
		expect(Reflect.apply(copyWithin, receiver, [2, 0, 1])).toBe(receiver);
		expect(receiver).toEqual([2, 7, 2, 5]);
		expect(change.state.values).toEqual([1, 2, 3]);
		change.abort();
	});

	it("matches native structural coercion ordering for splice, fill, and copyWithin", () => {
		const compare = (mutateNative: (values: number[]) => void, mutateDraft: (values: number[]) => void): void => {
			const native = [1, 2, 3];
			mutateNative(native);
			const tracker = track({ values: [1, 2, 3] });
			settle(tracker, (draft) => mutateDraft(draft.values));
			expect(tracker.value.values).toEqual(native);
		};
		compare(
			(values) => {
				values.splice(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					1,
					9,
				);
			},
			(values) => {
				values.splice(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					1,
					9,
				);
			},
		);
		compare(
			(values) => {
				values.fill(7, {
					valueOf() {
						values.push(4);
						return 1;
					},
				} as unknown as number);
			},
			(values) => {
				values.fill(7, {
					valueOf() {
						values.push(4);
						return 1;
					},
				} as unknown as number);
			},
		);
		compare(
			(values) => {
				values.copyWithin(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					0,
					2,
				);
			},
			(values) => {
				values.copyWithin(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					0,
					2,
				);
			},
		);
	});

	it("does not report inherited methods as own array properties", () => {
		const tracker = track({ values: [1] });
		const change = tracker.beginChange();
		expect(Object.getOwnPropertyDescriptor(change.state.values, "map")).toBeUndefined();
		change.abort();
	});

	it("keeps repeated identical writes instead of reverting their pending override", () => {
		const tracker = track({ value: 0, values: [0] as Array<number | null> });
		settle(tracker, (draft) => {
			draft.value = 1;
			draft.value = 1;
			draft.values[0] = null;
			draft.values[0] = null;
			draft.values.push(2);
			draft.values[1] = null;
			draft.values[1] = null;
		});
		expect(tracker.value).toEqual({ value: 1, values: [null, null] });
	});

	it("rejects array index gaps without mutation while allowing replacement and append", () => {
		const tracker = track({ values: [1, 2] });
		const change = tracker.beginChange();
		expect(() => {
			change.state.values[3] = 4;
		}).toThrow(/holes/);
		expect(change.state.values).toEqual([1, 2]);
		expect(tracker.value.values).toEqual([1, 2]);

		change.state.values[1] = 9;
		change.state.values[2] = 3;
		const prepared = change.prepare();
		expect(prepared.value.values).toEqual([1, 9, 3]);
		expect(replay(tracker.value, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(tracker.value.values).toEqual([1, 9, 3]);
	});

	it("supports optional deletion, explicit null length growth, shrinking, and default sort", () => {
		const tracker = track({ optional: "remove" as string | undefined, values: [3, 1, 2] as Array<number | null> });
		settle(tracker, (draft) => {
			draft.optional = undefined;
			draft.values.length = 5;
			expect(draft.values).toEqual([3, 1, 2, null, null]);
			draft.values.length = 4;
			draft.values.sort();
			expect(() => delete draft.values[0]).toThrow(/holes/);
		});
		expect(tracker.value).toEqual({ values: [1, 2, 3, null] });
	});

	it("enumerates wide objects without duplicate keys", () => {
		const tracker = track({ values: {} as Record<string, number> });
		const change = tracker.beginChange();
		for (let index = 0; index < 20_000; index++) change.state.values[`field${index}`] = index;
		const keys = Object.keys(change.state.values);
		expect(keys).toHaveLength(20_000);
		expect(keys[0]).toBe("field0");
		expect(keys.at(-1)).toBe("field19999");
		change.abort();
	});

	it("does not dirty read-only traversals", () => {
		const tracker = track({ nested: { rows: [{ value: 1 }] } });
		const change = tracker.beginChange();
		expect(change.state.nested.rows[0]!.value).toBe(1);
		const prepared = change.prepare();
		expect(prepared.ops).toEqual([]);
		tracker.adopt(prepared);
	});

	it("uses one proxy identity per accessed container", () => {
		const tracker = track({ nested: { value: 1 }, rows: [{ value: 2 }] });
		const change = tracker.beginChange();
		expect(change.state.nested).toBe(change.state.nested);
		expect(change.state.rows).toBe(change.state.rows);
		expect(change.state.rows[0]).toBe(change.state.rows[0]);
		change.abort();
	});
});

describe("delta tracker by-value placements", () => {
	it("clones property, index, push, unshift, splice, fill, and copyWithin placements", () => {
		const tracker = track({
			property: null as { value: number } | null,
			values: [{ value: 0 }, { value: 1 }, { value: 2 }],
		});
		const external = { value: 5 };
		const change = tracker.beginChange();
		change.state.property = external;
		change.state.values[0] = external;
		change.state.values.push(external);
		change.state.values.unshift(external);
		change.state.values.splice(2, 0, external);
		external.value = 99;
		change.state.values.fill(change.state.values[0]!, 1, 3);
		change.state.values.copyWithin(3, 0, 2);
		const prepared = change.prepare();
		const candidate = clone(prepared.value);
		expect(candidate.property).toEqual({ value: 5 });
		expect(candidate.values.slice(0, 5)).toEqual([
			{ value: 5 },
			{ value: 5 },
			{ value: 5 },
			{ value: 5 },
			{ value: 5 },
		]);
		tracker.adopt(prepared);
	});

	it("rejects non-strict JSON placements before changing the draft", () => {
		const initial = {
			optional: "remove" as string | undefined,
			payload: null as JsonValue,
			number: 0,
			values: [1, 2] as JsonValue[],
		};
		const tracker = track(initial);
		const change = tracker.beginChange();
		const undefinedValue = undefined as unknown as JsonValue;

		expect(() => {
			change.state.values[0] = undefinedValue;
		}).toThrow(/strict JSON/);
		expect(() => change.state.values.push({ staged: true }, undefinedValue)).toThrow(/strict JSON/);
		expect(() => change.state.values.unshift(undefinedValue)).toThrow(/strict JSON/);
		expect(() => change.state.values.splice(1, 0, undefinedValue)).toThrow(/strict JSON/);
		expect(() => change.state.values.fill(undefinedValue)).toThrow(/strict JSON/);
		expect(() => {
			change.state.payload = { nested: undefined } as unknown as JsonValue;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.payload = { nested: () => 1 } as unknown as JsonValue;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.payload = { nested: Symbol("invalid") } as unknown as JsonValue;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.payload = { nested: 1n } as unknown as JsonValue;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.number = Number.NaN;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.number = Number.POSITIVE_INFINITY;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.payload = new Date() as unknown as JsonValue;
		}).toThrow(/plain objects/);

		const sparse: JsonValue[] = new Array<JsonValue>(1);
		expect(() => {
			change.state.payload = sparse;
		}).toThrow(/dense plain arrays/);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => {
			change.state.payload = cyclic as JsonValue;
		}).toThrow(/cycles/);
		let accessorReads = 0;
		const accessor = Object.defineProperty({}, "value", {
			enumerable: true,
			get() {
				accessorReads += 1;
				return 1;
			},
		});
		expect(() => {
			change.state.payload = accessor as JsonValue;
		}).toThrow(/data properties/);
		expect(accessorReads).toBe(0);

		expect(change.state).toEqual(initial);
		change.state.optional = undefined;
		const dictionary = Object.create(null) as Record<string, JsonValue>;
		dictionary.valid = true;
		change.state.payload = dictionary;
		change.state.values.push({ valid: true });
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ payload: { valid: true }, number: 0, values: [1, 2, { valid: true }] });
		expect(Object.getPrototypeOf(prepared.value.payload)).toBeNull();
		expect(replay(initial, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("expands repeated source aliases into independent placements", () => {
		const tracker = track({
			left: null as { nested: { value: number } } | null,
			right: null as { nested: { value: number } } | null,
			rows: [] as { nested: { value: number } }[],
		});
		const shared = { nested: { value: 1 } };
		const change = tracker.beginChange();
		change.state.left = shared;
		change.state.right = shared;
		change.state.rows.push(shared, shared);
		change.state.left.nested.value = 9;
		change.state.rows[0]!.nested.value = 8;
		const prepared = change.prepare();
		expect(prepared.value).toEqual({
			left: { nested: { value: 9 } },
			right: { nested: { value: 1 } },
			rows: [{ nested: { value: 8 } }, { nested: { value: 1 } }],
		});
		expect(prepared.value.left).not.toBe(prepared.value.right);
		expect(prepared.value.rows[0]).not.toBe(prepared.value.rows[1]);
		expect(replay(tracker.value, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("deep-clones draft-sourced placements within and across revisions", () => {
		const tracker = track({
			a: { child: { value: 1 } },
			b: null as { child: { value: number } } | null,
			rows: [{ child: { value: 1 } }, { child: { value: 2 } }],
		});
		const first = tracker.beginChange();
		first.state.b = first.state.a;
		first.state.b.child.value = 3;
		first.state.rows[1] = first.state.rows[0]!;
		const firstPrepared = first.prepare();
		expect(firstPrepared.value.a.child.value).toBe(1);
		expect(firstPrepared.value.b?.child.value).toBe(3);
		expect(firstPrepared.value.a).not.toBe(firstPrepared.value.b);
		expect(firstPrepared.value.a.child).not.toBe(firstPrepared.value.b?.child);
		expect(firstPrepared.value.rows[0]).not.toBe(firstPrepared.value.rows[1]);
		expect(firstPrepared.value.rows[0]!.child).not.toBe(firstPrepared.value.rows[1]!.child);
		expectAliasFree(firstPrepared.value);
		tracker.adopt(firstPrepared);

		const base = clone(tracker.value);
		const second = tracker.beginChange();
		second.state.rows[1]!.child.value = 4;
		const secondPrepared = second.prepare();
		expect(secondPrepared.value.rows.map((row) => row.child.value)).toEqual([1, 4]);
		expect(replay(base, secondPrepared.ops)).toEqual(secondPrepared.value);
		expectAliasFree(secondPrepared.value);
		tracker.adopt(secondPrepared);
	});

	it("distinguishes raw committed references from draft references", () => {
		const tracker = track({
			source: { value: 1 },
			rawCopy: null as { value: number } | null,
			draftCopy: null as { value: number } | null,
		});
		const raw = tracker.value.source;
		const change = tracker.beginChange();
		change.state.source.value = 2;
		change.state.rawCopy = raw;
		change.state.draftCopy = change.state.source;
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ source: { value: 2 }, rawCopy: { value: 1 }, draftCopy: { value: 2 } });
		tracker.adopt(prepared);
	});

	it("folds edits to introduced object and array subtrees into placement payloads", () => {
		const tracker = track({
			nested: null as { rows: { value: number }[] } | null,
			rows: [] as { values: number[] }[],
		});
		const change = tracker.beginChange();
		change.state.nested = { rows: [{ value: 1 }] };
		change.state.nested.rows[0]!.value = 2;
		change.state.nested.rows.push({ value: 3 });
		change.state.rows.push({ values: [1] });
		change.state.rows[0]!.values.push(2);
		const prepared = change.prepare();
		expect(prepared.ops).toEqual([
			["s", ["nested"], { rows: [{ value: 2 }, { value: 3 }] }],
			["p", ["rows"], 0, 0, [{ values: [1, 2] }]],
		]);
		expect(replay(tracker.value, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("folds pathological operation counts without payload-cost estimation", () => {
		const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`field${index}`, 0])) as Record<
			string,
			number
		>;
		const wideTracker = track(wide);
		const wideBase = clone(wideTracker.value);
		const wideChange = wideTracker.beginChange();
		for (let index = 0; index < 5_000; index++) wideChange.state[`field${index}`] = 1;
		const widePrepared = wideChange.prepare();
		expect(widePrepared.ops).toHaveLength(1);
		expect(widePrepared.ops[0]?.[0]).toBe("r");
		expect(replay(wideBase, widePrepared.ops)).toEqual(widePrepared.value);
		wideTracker.adopt(widePrepared);

		const sparseTracker = track({ rows: Array.from({ length: 15_000 }, (_, value) => ({ value })) });
		const sparseBase = clone(sparseTracker.value);
		const sparseChange = sparseTracker.beginChange();
		for (let index = 0; index < 15_000; index += 3) sparseChange.state.rows[index]!.value = -index - 1;
		const sparsePrepared = sparseChange.prepare();
		expect(sparsePrepared.ops).toHaveLength(1);
		expect(sparsePrepared.ops[0]?.[0]).toBe("r");
		expect(replay(sparseBase, sparsePrepared.ops)).toEqual(sparsePrepared.value);
		sparseTracker.adopt(sparsePrepared);
	}, 30_000);

	it("shares immutable operation placements with the materialized candidate", () => {
		const tracker = track({ rows: [] as { value: number }[] });
		const change = tracker.beginChange();
		change.state.rows.push({ value: 1 });
		const prepared = change.prepare();
		const operations = prepared.ops;
		const pending: unknown[] = [...operations];
		while (pending.length > 0) {
			const value = pending.pop();
			if (value === null || typeof value !== "object") continue;
			expect(isProxy(value)).toBe(false);
			pending.push(...Object.values(value));
		}
		const splice = operations[0];
		if (splice?.[0] !== "p") throw new Error("expected splice");
		expect(splice[4][0]).toBe(prepared.value.rows[0]);
		tracker.adopt(prepared);
		expect(tracker.value).toBe(prepared.value);
	});
});

describe("delta tracker piece arrays", () => {
	it("keeps adoption independent from mutable detached permutation metadata", () => {
		const tracker = track({ values: [3, 1, 2] });
		const change = tracker.beginChange();
		change.state.values.sort((left, right) => left - right);
		const prepared = change.prepare();
		const permutation = prepared.ops.find((operation) => operation[0] === "m");
		if (permutation?.[0] !== "m") throw new Error("expected permutation");
		permutation[2].reverse();
		tracker.adopt(prepared);
		expect(tracker.value.values).toEqual([1, 2, 3]);
	});

	it("matches native splice with zero or one argument", () => {
		const noArguments = track({ values: [1, 2, 3] });
		const noArgumentsChange = noArguments.beginChange();
		expect(Reflect.apply(noArgumentsChange.state.values.splice, noArgumentsChange.state.values, [])).toEqual([]);
		const noArgumentsPrepared = noArgumentsChange.prepare();
		expect(noArgumentsPrepared.value.values).toEqual([1, 2, 3]);
		expect(noArgumentsPrepared.ops).toEqual([]);
		noArguments.adopt(noArgumentsPrepared);

		const oneArgument = track({ values: [1, 2, 3, 4] });
		const oneArgumentChange = oneArgument.beginChange();
		expect(oneArgumentChange.state.values.splice(1)).toEqual([2, 3, 4]);
		const oneArgumentPrepared = oneArgumentChange.prepare();
		expect(oneArgumentPrepared.value.values).toEqual([1]);
		expect(replay(oneArgument.value, oneArgumentPrepared.ops)).toEqual(oneArgumentPrepared.value);
		oneArgument.adopt(oneArgumentPrepared);

		const pastEnd = track({ values: [1, 2, 3] });
		const pastEndChange = pastEnd.beginChange();
		expect(pastEndChange.state.values.splice(3)).toEqual([]);
		const pastEndPrepared = pastEndChange.prepare();
		expect(pastEndPrepared.value.values).toEqual([1, 2, 3]);
		pastEnd.adopt(pastEndPrepared);
	});

	it("supports all structural mutators and native return values", () => {
		const tracker = track({ values: [3, 1, 2] });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		expect(change.state.values.push(4)).toBe(4);
		expect(change.state.values.pop()).toBe(4);
		expect(change.state.values.unshift(0)).toBe(4);
		expect(change.state.values.shift()).toBe(0);
		expect(change.state.values.splice(1, 1, 5, 4)).toEqual([1]);
		expect(change.state.values.sort((left, right) => left - right)).toBe(change.state.values);
		expect(change.state.values.reverse()).toBe(change.state.values);
		change.state.values.fill(9, 1, 3);
		change.state.values.copyWithin(1, 0, 2);
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ values: [5, 5, 9, 2] });
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("tracks held handles after reindex and suppresses detached writes", () => {
		const tracker = track({ values: [{ value: "a" }, { value: "b" }, { value: "c" }] });
		const change = tracker.beginChange();
		const held = change.state.values[1]!;
		change.state.values.unshift({ value: "front" });
		held.value = "moved";
		expect(change.state.values[2]!.value).toBe("moved");
		change.state.values.splice(2, 1);
		held.value = "detached";
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ values: [{ value: "front" }, { value: "a" }, { value: "c" }] });
		expect(replay(tracker.value, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("replays introduced, moved, then edited array descendants", () => {
		const tracker = track({ values: [] as { id: number; nested: number[] }[] });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		change.state.values.push({ id: 1, nested: [1] });
		const held = change.state.values[0]!;
		change.state.values.unshift({ id: 0, nested: [] });
		held.nested.push(2);
		change.state.values.reverse();
		held.nested.push(3);
		const prepared = change.prepare();
		expect(prepared.value).toEqual({
			values: [
				{ id: 1, nested: [1, 2, 3] },
				{ id: 0, nested: [] },
			],
		});
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("combines movement and edits with permutation plus final paths", () => {
		const tracker = track({
			values: [
				{ rank: 3, edited: 0 },
				{ rank: 1, edited: 0 },
				{ rank: 2, edited: 0 },
			],
		});
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		const held = change.state.values[0]!;
		change.state.values.sort((left, right) => left.rank - right.rank);
		held.edited = 1;
		const prepared = change.prepare();
		expect(prepared.ops[0]).toEqual(["m", ["values"], [1, 2, 0]]);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("keeps comparator writes and structurally reentrant appends", () => {
		const tracker = track({
			values: [
				{ rank: 2, comparisons: 0 },
				{ rank: 1, comparisons: 0 },
			],
		});
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		let appended = false;
		change.state.values.sort((left, right) => {
			left.comparisons++;
			right.comparisons++;
			if (!appended) {
				appended = true;
				change.state.values[0] = { rank: 9, comparisons: 0 };
				change.state.values.push({ rank: 3, comparisons: 0 });
			}
			return left.rank - right.rank;
		});
		const prepared = change.prepare();
		expect(prepared.value.values.map((value) => value.rank)).toEqual([1, 2, 3]);
		expect(prepared.value.values.map((value) => value.comparisons)).toEqual([1, 1, 0]);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("normalizes duplicate entries created by structurally reentrant sort callbacks", () => {
		const tracker = track({
			values: [
				{ rank: 2, edited: 0, nested: { value: 0 } },
				{ rank: 1, edited: 0, nested: { value: 0 } },
			],
		});
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		let inserted = false;
		change.state.values.sort((left, right) => {
			left.edited = left.rank * 10;
			left.nested.value = left.rank * 100;
			right.edited = right.rank * 10;
			right.nested.value = right.rank * 100;
			if (!inserted) {
				inserted = true;
				change.state.values.unshift({ rank: 4, edited: 0, nested: { value: 0 } });
			}
			return left.rank - right.rank;
		});
		const prepared = change.prepare();
		expect(prepared.value.values.map((value) => value.rank)).toEqual([1, 2, 1]);
		expect(prepared.value.values.map((value) => value.edited)).toEqual([10, 20, 10]);
		expect(prepared.value.values.map((value) => value.nested.value)).toEqual([100, 200, 100]);
		expect(prepared.value.values[0]).not.toBe(prepared.value.values[2]);
		expect(prepared.value.values[0]!.nested).not.toBe(prepared.value.values[2]!.nested);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		expectAliasFree(prepared.value);
		tracker.adopt(prepared);
	});

	it("folds dense child and direct-index edits into one full-array operation", () => {
		const rowsTracker = track({ rows: Array.from({ length: 1_000 }, (_, value) => ({ value })) });
		const rowsBase = clone(rowsTracker.value);
		const rowsChange = rowsTracker.beginChange();
		for (const row of rowsChange.state.rows) row.value += 1;
		const rowsPrepared = rowsChange.prepare();
		expect(rowsPrepared.ops).toHaveLength(1);
		expect(rowsPrepared.ops[0]?.[0]).toBe("p");
		expect(replay(rowsBase, rowsPrepared.ops)).toEqual(rowsPrepared.value);
		rowsTracker.adopt(rowsPrepared);

		const valuesTracker = track({ values: Array.from({ length: 1_000 }, (_, value) => value) });
		const valuesBase = clone(valuesTracker.value);
		const valuesChange = valuesTracker.beginChange();
		for (let index = 0; index < 600; index++) valuesChange.state.values[index] = -index - 1;
		const valuesPrepared = valuesChange.prepare();
		expect(valuesPrepared.ops).toHaveLength(1);
		expect(valuesPrepared.ops[0]?.[0]).toBe("p");
		expect(replay(valuesBase, valuesPrepared.ops)).toEqual(valuesPrepared.value);
		valuesTracker.adopt(valuesPrepared);
	});

	it("folds only a deeply nested dense array region", () => {
		const tracker = track({
			rows: Array.from({ length: 2_000 }, (_, value) => ({ nested: { value } })),
		});
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		change.state.rows[0]!.nested.value = -1;
		for (let index = 500; index < 1_000; index++) change.state.rows[index]!.nested.value = -index;
		const prepared = change.prepare();
		const splice = prepared.ops.find((operation) => operation[0] === "p");
		expect(splice?.slice(0, 4)).toEqual(["p", ["rows"], 500, 500]);
		if (splice?.[0] !== "p") throw new Error("expected regional splice");
		expect(splice[4]).toHaveLength(500);
		expect(prepared.ops).toHaveLength(2);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("does not cache emission paths for nested reserved-key folds covered by an outer region", () => {
		type Row = { flag: number; special?: { __proto__: { values: number[] } } };
		const rows: Row[] = Array.from({ length: 400 }, () => ({ flag: 0 }));
		rows[100]!.special = JSON.parse(
			`{"__proto__":{"values":[${Array.from({ length: 400 }, (_, value) => value).join(",")}]}}`,
		) as Row["special"];
		const tracker = track({ rows });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		for (let index = 0; index < 256; index++) change.state.rows[index]!.flag = 1;
		for (let index = 0; index < 256; index++) {
			change.state.rows[100]!.special!.__proto__.values[index] = -index - 1;
		}
		const prepared = change.prepare();
		expect(prepared.ops).toHaveLength(1);
		expect(prepared.ops[0]?.slice(0, 4)).toEqual(["p", ["rows"], 0, 256]);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("suppresses nested structural and leaf operations covered by an outer dense region", () => {
		const tracker = track({
			rows: Array.from({ length: 400 }, (_, index) => ({
				flag: 0,
				values: index === 100 ? Array.from({ length: 400 }, (_, value) => ({ value })) : [],
			})),
		});
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		for (let index = 0; index < 256; index++) change.state.rows[index]!.flag = 1;
		for (let index = 0; index < 256; index++) change.state.rows[100]!.values[index]!.value = -index - 1;
		change.state.rows[100]!.values.push({ value: 999 });
		const prepared = change.prepare();
		expect(prepared.ops).toHaveLength(1);
		expect(prepared.ops[0]?.slice(0, 4)).toEqual(["p", ["rows"], 0, 256]);
		expect(prepared.value.rows[100]!.values).toHaveLength(401);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("emits multiple disjoint dense regions and preserves operations outside their boundaries", () => {
		const tracker = track({ values: Array.from({ length: 1_400 }, (_, value) => ({ value })) });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		for (const index of [97, 358, 897, 1_158]) change.state.values[index]!.value = -index - 1;
		for (let index = 100; index < 356; index++) change.state.values[index]!.value = -index - 1;
		for (let index = 900; index < 1_156; index++) change.state.values[index]!.value = -index - 1;
		const prepared = change.prepare();
		const splices = prepared.ops.filter((operation) => operation[0] === "p");
		expect(splices.map((operation) => operation.slice(0, 4))).toEqual([
			["p", ["values"], 100, 256],
			["p", ["values"], 900, 256],
		]);
		for (const index of [97, 358, 897, 1_158]) {
			expect(prepared.ops).toContainEqual(["s", ["values", index, "value"], -index - 1]);
		}
		expect(prepared.ops).toHaveLength(6);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("normalizes a 20,000-operation queue transaction to two operations", () => {
		const tracker = track({ values: Array.from({ length: 20_000 }, (_, value) => ({ value })) });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		for (let index = 0; index < 10_000; index++) {
			change.state.values.shift();
			change.state.values.push({ value: 20_000 + index });
		}
		const prepared = change.prepare();
		expect(prepared.ops).toHaveLength(2);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("handles adversarial fragmentation and resolves held handles without piece scans", () => {
		const size = 20_000;
		const tracker = track({ values: Array.from({ length: size }, (_, value) => ({ value })) });
		const expected = clone(tracker.value);
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		const held = [1, 1_001, 5_001, 10_001, 15_001, 19_999].map((index) => change.state.values[index]!);
		for (let index = 0; index < size; index += 2) {
			change.state.values.splice(index, 1, { value: -index - 1 });
			expected.values.splice(index, 1, { value: -index - 1 });
		}
		for (const value of held) value.value += 100_000;
		for (const index of [1, 1_001, 5_001, 10_001, 15_001, 19_999]) expected.values[index]!.value += 100_000;
		const prepared = change.prepare();
		expect(prepared.value).toEqual(expected);
		expect(replay(base, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
	}, 30_000);

	it("normalizes restored overrides and cancelled structural edits to no operations", () => {
		const tracker = track({ values: [1, 2, 3] });
		const change = tracker.beginChange();
		change.state.values[1] = 9;
		change.state.values[1] = 2;
		change.state.values.reverse();
		change.state.values.reverse();
		change.state.values.push(4);
		expect(change.state.values.pop()).toBe(4);
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ values: [1, 2, 3] });
		expect(prepared.ops).toEqual([]);
		tracker.adopt(prepared);
	});

	it("handles null sparse overrides without confusing absence", () => {
		const tracker = track({ values: Array.from({ length: 10_000 }, (_, value): number | null => value) });
		settle(tracker, (draft) => {
			draft.values[17] = null;
			draft.values[9_000] = null;
		});
		expect(tracker.value.values[17]).toBeNull();
		expect(tracker.value.values[9_000]).toBeNull();
	});

	it("supports self-overlapping fill and copyWithin by value", () => {
		const tracker = track({ values: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }] });
		settle(tracker, (draft) => {
			draft.values.copyWithin(1, 0, 3);
			draft.values.fill(draft.values[1]!, 0, 2);
			draft.values[0]!.n = 9;
		});
		expect(tracker.value.values.map((value) => value.n)).toEqual([9, 0, 1, 2]);
		expect(tracker.value.values[0]).not.toBe(tracker.value.values[1]);
	});

	it.each(["unshift", "splice"] as const)(
		"inserts 100,000 items with %s",
		(method) => {
			const tracker = track({ values: [-1] });
			const base = clone(tracker.value);
			const change = tracker.beginChange();
			const items = Array.from({ length: 100_000 }, (_, value) => value);
			if (method === "unshift") Reflect.apply(change.state.values.unshift, change.state.values, items);
			else Reflect.apply(change.state.values.splice, change.state.values, [1, 0, ...items]);
			const prepared = change.prepare();
			expect(prepared.value.values).toHaveLength(100_001);
			expect(prepared.value.values[method === "unshift" ? 99_999 : 100_000]).toBe(99_999);
			expect(replay(base, prepared.ops)).toEqual(prepared.value);
			tracker.adopt(prepared);
		},
		30_000,
	);
});

describe("delta tracker randomized transactions", () => {
	type Document = {
		values: { id: number; score: number }[];
		text: string;
		meta: { revision: number; label?: string };
	};
	const random =
		(seed: number): (() => number) =>
		() => {
			seed = (seed + 0x6d2b79f5) | 0;
			let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
			return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
		};
	const mutate = (document: Document | Draft<Document>, choice: number, value: number): void => {
		const item = (): { id: number; score: number } => ({ id: value, score: value % 7 });
		switch (choice) {
			case 0:
				document.text += `-${value}`;
				break;
			case 1:
				document.values.push(item());
				break;
			case 2:
				document.values.unshift(item());
				break;
			case 3:
				if (document.values.length > 0) document.values.shift();
				break;
			case 4:
				if (document.values.length > 0) document.values.pop();
				break;
			case 5: {
				const index = document.values.length === 0 ? 0 : value % (document.values.length + 1);
				document.values.splice(index, document.values.length === 0 ? 0 : value % 2, item());
				break;
			}
			case 6:
				document.values.reverse();
				break;
			case 7:
				document.values.sort((left, right) => left.id - right.id);
				break;
			case 8:
				if (document.values.length > 0) document.values[value % document.values.length]!.score = value;
				break;
			case 9:
				document.meta.revision++;
				document.meta.label = `r-${value}`;
				break;
			default:
				delete document.meta.label;
		}
	};

	it("matches policy, detached replay, and adopted state after multi-operation transactions", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const rng = random(seed);
			const initial: Document = {
				values: Array.from({ length: 4 }, (_, id) => ({ id, score: 0 })),
				text: "start",
				meta: { revision: 0 },
			};
			const tracker = track(initial);
			const expected = clone(initial);
			for (let transaction = 0; transaction < 25; transaction++) {
				const baseRoot = tracker.value;
				const base = clone(baseRoot);
				const change = tracker.beginChange();
				for (let operation = 0; operation < 5; operation++) {
					const choice = Math.floor(rng() * 11);
					const value = seed * 10_000 + transaction * 10 + operation;
					mutate(expected, choice, value);
					mutate(change.state, choice, value);
				}
				const prepared = change.prepare();
				const policy = clone(prepared.value);
				expect(isProxy(prepared.value)).toBe(false);
				expect(baseRoot, `prepare changed base seed ${seed} transaction ${transaction}`).toEqual(base);
				expect(policy, `policy seed ${seed} transaction ${transaction}`).toEqual(expected);
				expect(replay(base, prepared.ops), `replay seed ${seed} transaction ${transaction}`).toEqual(policy);
				tracker.adopt(prepared);
				expect(baseRoot, `adopt changed base seed ${seed} transaction ${transaction}`).toEqual(base);
				expect(tracker.value, `adopt seed ${seed} transaction ${transaction}`).toBe(prepared.value);
				expect(tracker.value, `adopt seed ${seed} transaction ${transaction}`).toEqual(policy);
				expectAliasFree(tracker.value);
			}
		}
	}, 30_000);
});

describe("delta tracker object emission scaling", () => {
	it("orders many reverse-depth object edits through the bounded fallback", () => {
		type DeepNode = { value: number; next?: DeepNode };
		let initial: DeepNode = { value: 0 };
		for (let depth = 0; depth < 512; depth++) initial = { value: 0, next: initial };
		const tracker = track(initial);
		const change = tracker.beginChange();
		const nodes: Array<Draft<DeepNode>> = [];
		let node: Draft<DeepNode> | undefined = change.state;
		while (node !== undefined) {
			nodes.push(node);
			node = node.next;
		}
		for (let index = nodes.length - 1; index >= 0; index--) nodes[index]!.value = index + 1;
		const prepared = change.prepare();
		expect(prepared.ops).toHaveLength(nodes.length);
		expect(replay(initial, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
		expectAliasFree(tracker.value);
	});
});

describe("delta tracker security and storage-style cloning", () => {
	it("defines own properties without invoking inherited setters", () => {
		const tracker = track({} as Record<string, JsonValue>);
		Object.defineProperty(Object.prototype, "trap", {
			set() {
				throw new Error("inherited setter ran");
			},
			configurable: true,
		});
		try {
			settle(tracker, (draft) => {
				draft.trap = 1;
			});
			expect(tracker.value).toEqual({ trap: 1 });
		} finally {
			delete (Object.prototype as Record<string, unknown>).trap;
		}
	});

	it("handles reserved own keys without prototype pollution", () => {
		const initial = JSON.parse('{"safe":{"__proto__":{"value":1}}}') as {
			safe: { __proto__: { value: number } };
		};
		const tracker = track(initial);
		const change = tracker.beginChange();
		change.state.safe.__proto__.value = 2;
		const prepared = change.prepare();
		expect(prepared.value.safe.__proto__.value).toBe(2);
		expect(replay(tracker.value, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(({} as Record<string, unknown>).value).toBeUndefined();
	});

	it("supports a MemoryStorage-style recursive clone of Prepared.value", () => {
		const storageClone = <T>(value: T): T => {
			if (value === null || typeof value !== "object") return value;
			if (Array.isArray(value)) return value.map(storageClone) as T;
			const output: Record<string, unknown> = {};
			for (const key of Object.keys(value))
				Object.defineProperty(output, key, {
					value: storageClone((value as Record<string, unknown>)[key]),
					writable: true,
					enumerable: true,
					configurable: true,
				});
			return output as T;
		};
		const tracker = track({ rows: [{ value: 1 }] });
		const change = tracker.beginChange();
		change.state.rows[0]!.value = 2;
		change.state.rows.push({ value: 3 });
		const prepared = change.prepare();
		expect(storageClone(prepared.value)).toEqual({ rows: [{ value: 2 }, { value: 3 }] });
		tracker.adopt(prepared);
	});
});
