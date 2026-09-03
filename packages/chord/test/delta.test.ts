import { describe, expect, it } from "vitest";
import {
	apply,
	applyImmutable,
	assertValidOp,
	assertValidWireOp,
	decoder,
	encoder,
	isBase,
	type JsonValue,
	type Op,
	overlap,
	track,
	type WireOp,
} from "../src/delta/index.ts";

const PAD = "p".repeat(400); // see "adaptive emission": a delta must be able to win

describe("overlap", () => {
	it("finds an overlap shorter than the long probe", () => {
		expect(overlap("abcdefgh", "defghxyz", 65_536)).toBe(5);
	});

	it("honors a disabled scan", () => {
		expect(overlap("abcdef", "defghi", 0)).toBe(0);
	});
});

describe("tracker: intent", () => {
	it("records an append, not a replacement", () => {
		const t = track({ s: "", pad: PAD });
		t.flush(); // drain the base batch
		t.state.s += "ab";
		t.state.s += "cd";
		const ops = t.flush();
		expect(ops).toEqual([["a", ["s"], "abcd"]]);
		expect(apply({ s: "", pad: PAD }, ops)).toEqual({ s: "abcd", pad: PAD });
	});

	it("recovers truncate+append from a rolling window", () => {
		// The case every effect-recording library degrades to a whole-value set.
		const t = track({ s: "abcdefgh", pad: PAD });
		t.flush(); // drain the base batch
		t.state.s = `${t.state.s.slice(3)}xyz`;
		const ops = t.flush();
		expect(ops).toEqual([
			["t", ["s"], 3],
			["a", ["s"], "xyz"],
		]);
		expect(apply({ s: "abcdefgh", pad: PAD }, ops)).toEqual({ s: "defghxyz", pad: PAD });
	});

	it("caches nested proxies while replacing changed children", () => {
		const t = track({ child: { value: 1 } });
		const first = t.state.child;
		expect(t.state.child).toBe(first);
		t.state.child = { value: 2 };
		expect(t.state.child).not.toBe(first);
		expect(t.state.child).toBe(t.state.child);
	});

	it("records array intent as one splice", () => {
		const t = track({ xs: [1, 2], pad: PAD });
		t.flush(); // drain the base batch
		t.state.xs.push(3);
		expect(t.flush()).toEqual([["p", ["xs"], 2, 0, [3]]]);
	});

	it("normalises undefined to a delete", () => {
		const t = track({ a: 1, pad: PAD });
		t.flush(); // drain the base batch
		(t.state as Record<string, unknown>).a = undefined;
		expect(t.flush()).toEqual([["d", ["a"]]]);
	});

	it("uses absence and delete for optional object properties", () => {
		type Settings = { something?: string; foo: number };
		const t = track<Settings>({ foo: 1 });
		let replica = apply<Settings>(undefined, t.flush());
		expect(t.state.something).toBeUndefined();
		t.state.something = "enabled";
		replica = apply(replica, t.flush());
		expect(replica).toEqual({ foo: 1, something: "enabled" });
		t.state.something = undefined;
		const ops = t.flush();
		expect(ops).toEqual([["d", ["something"]]]);
		expect(apply(replica, ops)).toEqual({ foo: 1 });
	});

	it("round-trips interleaved writes", () => {
		const initial = { out: "x".repeat(500), total: 0 };
		const t = track(structuredClone(initial));
		t.flush();
		for (let i = 0; i < 1_000; i++) {
			t.state.out = `${t.state.out.slice(10)}${String(i).padStart(10, "0")}`;
			t.state.total += 10;
		}
		const ops = t.flush();
		expect(ops.length).toBeLessThanOrEqual(3);
		expect(apply(structuredClone(initial), ops)).toEqual(t.state);
	});

	it("deep-diffs reassigned objects", () => {
		const initial = { message: { content: [{ text: "hello" }], count: 0 } };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.message = { content: [{ text: "hello world" }], count: 1 };
		expect(t.flush()).toEqual([
			["a", ["message", "content", 0, "text"], " world"],
			["s", ["message", "count"], 1],
		]);
	});

	it("deep-diffs retained array edits combined with append in a replacement", () => {
		const initial = { view: { messages: [{ text: "a" }, { text: "b" }] } };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.view = { messages: [{ text: "ax" }, { text: "b" }, { text: "c" }] };
		const ops = t.flush();
		expect(ops).toEqual([
			["a", ["view", "messages", 0, "text"], "x"],
			["p", ["view", "messages"], 2, 0, [{ text: "c" }]],
		]);
		expect(apply(structuredClone(initial), ops)).toEqual(t.state);
	});

	it("emits nothing when a replacement is deeply equal", () => {
		const t = track({ value: { nested: [1, { text: "same" }] } });
		t.flush();
		t.state.value = { nested: [1, { text: "same" }] };
		expect(t.dirty).toBe(true);
		expect(t.flush()).toEqual([]);
		expect(t.dirty).toBe(false);
	});

	it("invalidates a pending child when its parent is overwritten", () => {
		const initial = { a: { x: 1 } as Record<string, number> };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.a.b = 99;
		t.state.a = { c: 2 };
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});
});

describe("tracker: root ops", () => {
	it("splices a value that is itself an array", () => {
		const t = track([1, 2, 3, PAD]);
		t.flush(); // drain the base batch
		t.state.push(4);
		const ops = t.flush();
		expect(ops).toEqual([["p", [], 4, 0, [4]]]);
		expect(apply([1, 2, 3, PAD], ops)).toEqual([1, 2, 3, PAD, 4]);
	});

	it("normalises a splice covering the whole root to a replacement", () => {
		const t = track([1, 2, 3]);
		t.flush(); // drain the base batch
		t.state.splice(0, 3, 9);
		const ops = t.flush();
		expect(ops).toEqual([["r", [9]]]);
		expect(isBase(ops)).toBe(true);
	});

	it("normalises a nested splice-all to a set, not a replacement", () => {
		const t = track({ xs: [1, 2, 3], pad: PAD });
		t.flush(); // drain the base batch
		t.state.xs.splice(0, 3, 9);
		expect(t.flush()).toEqual([["s", ["xs"], [9]]]);
	});

	it("matches splice with no arguments", () => {
		const initial = { xs: [1, 2, 3] };
		const t = track(structuredClone(initial));
		t.flush();
		(t.state.xs.splice as (...args: never[]) => number[])();
		expect(t.state).toEqual(initial);
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("normalises splice arguments to integers", () => {
		const initial = { xs: [1, 2, 3] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs.splice(0, undefined as unknown as number, 9);
		t.state.xs.splice(1.5, 1);
		const ops = t.flush();
		for (const op of ops) {
			if (op[0] !== "p") continue;
			expect(Number.isInteger(op[2])).toBe(true);
			expect(Number.isInteger(op[3])).toBe(true);
		}
		expect(apply(structuredClone(initial), ops)).toEqual(t.state);
	});

	it("normalises length = 0 on the root", () => {
		const t = track([1, 2, 3]);
		t.flush(); // drain the base batch
		t.state.length = 0;
		const ops = t.flush();
		expect(ops).toEqual([["r", []]]);
		expect(apply([1, 2, 3], ops)).toEqual([]);
	});

	it("round-trips repeated nested splices", () => {
		const initial = { xs: [1] };
		const t = track(structuredClone(initial));
		t.flush();
		for (let i = 2; i <= 100; i++) t.state.xs.push(i);
		const ops = t.flush();
		expect(apply(structuredClone(initial), ops)).toEqual(t.state);
	});

	it("does not fold a child path across a parent splice", () => {
		const initial = { xs: ["ab", "cd"] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs[0] += "x";
		t.state.xs.shift();
		t.state.xs[0] += "y";
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("drops child ops when repeated parent splices collapse to a snapshot", () => {
		const initial = { xs: ["ab"] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs.push("q");
		t.state.xs[0] += "cd";
		t.state.xs.push("z");
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("does not let a post-splice set dominate an earlier element append", () => {
		const initial = { xs: ["ab"] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs[0] += "x";
		t.state.xs.unshift("q");
		t.state.xs[0] = "Z";
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("does not discard a nested append through a reindexed set", () => {
		const initial = { xs: [{ k: "a" }] as ({ k: string } | number)[] };
		const t = track(structuredClone(initial));
		t.flush();
		(t.state.xs[0] as { k: string }).k += "x";
		t.state.xs.unshift(9);
		t.state.xs[0] = 7;
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("preserves element operations across middle-array insertions", () => {
		const initial = { xs: ["a", "b"] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs[1] += "x";
		t.state.xs.splice(1, 0, "inserted");
		t.state.xs[1] = "changed";
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("round-trips deterministic element mutations across reindexing splices", () => {
		let seed = 0x1234abcd;
		const next = (): number => {
			seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
			return seed;
		};
		for (let round = 0; round < 200; round++) {
			const initial = { xs: [{ k: "a" }, { k: "b" }, { k: "c" }] };
			const t = track(structuredClone(initial));
			t.flush();
			for (let step = 0; step < 30; step++) {
				const index = next() % t.state.xs.length;
				switch (next() % 5) {
					case 0:
						t.state.xs[index]!.k += String.fromCharCode(97 + (next() % 26));
						break;
					case 1:
						t.state.xs[index] = { k: `set-${round}-${step}` };
						break;
					case 2:
						t.state.xs.unshift({ k: `head-${round}-${step}` });
						break;
					case 3:
						if (t.state.xs.length > 1) t.state.xs.shift();
						break;
					default: {
						const at = next() % (t.state.xs.length + 1);
						const remove = t.state.xs.length > 1 && next() % 2 === 0 ? 1 : 0;
						t.state.xs.splice(at, remove, { k: `mid-${round}-${step}` });
					}
				}
				if (t.state.xs.length > 10) t.state.xs.shift();
			}
			expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
		}
	});

	it("keeps mutator chaining tracked", () => {
		const initial = { xs: [3, 1, 2] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs.sort().push(4);
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});

	it("combines retained element edits with one append", () => {
		const initial = { messages: [{ text: "a" }, { text: "b" }], flag: 0 };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.messages[0]!.text += "x";
		t.state.flag = 1;
		t.state.messages.push({ text: "c" });
		t.state.messages[1]!.text += "y";
		t.state.messages[2]!.text += "z";
		const ops = t.flush();
		expect(ops.filter((op) => op[0] === "p")).toEqual([["p", ["messages"], 2, 0, [{ text: "cz" }]]]);
		expect(ops.some((op) => op[0] === "s" && op[1].length === 1 && op[1][0] === "messages")).toBe(false);
		expect(ops.some((op) => op[0] !== "r" && op[1].includes(2))).toBe(false);
		expect(apply(structuredClone(initial), ops)).toEqual(t.state);
	});

	it("collapses many pushes into one append", () => {
		const t = track({ xs: [1] });
		t.flush();
		for (let value = 2; value <= 100; value++) t.state.xs.push(value);
		expect(t.flush()).toEqual([["p", ["xs"], 1, 0, Array.from({ length: 99 }, (_, index) => index + 2)]]);
	});

	it("keeps direct tail writes and length growth in append mode", () => {
		const t = track({ xs: [1] as JsonValue[] });
		t.flush();
		t.state.xs[1] = { value: 2 };
		(t.state.xs[1] as { value: number }).value = 3;
		t.state.xs.length = 4;
		expect(t.flush()).toEqual([["p", ["xs"], 1, 0, [{ value: 3 }, null, null]]]);
	});

	it("keeps tail-only splices in append mode", () => {
		const t = track({ xs: [{ value: 1 }] });
		t.flush();
		t.state.xs.push({ value: 2 }, { value: 3 });
		t.state.xs.splice(1, 1, { value: 4 });
		t.state.xs[2]!.value = 5;
		expect(t.flush()).toEqual([["p", ["xs"], 1, 0, [{ value: 4 }, { value: 5 }]]]);
	});

	it("forgets append-tail mutations that cancel out", () => {
		const t = track({ xs: [1] });
		t.flush();
		t.state.xs.push(2);
		t.state.xs.push(3);
		t.state.xs.pop();
		t.state.xs.pop();
		expect(t.flush()).toEqual([]);
	});

	it("accepts large append argument lists without spreading them internally", () => {
		const t = track({ xs: [] as JsonValue[] });
		t.flush();
		const items = Array<JsonValue>(100_000).fill(null);
		expect(Reflect.apply(t.state.xs.push, t.state.xs, items)).toBe(items.length);
		expect(t.flush()).toEqual([["p", ["xs"], 0, 0, items]]);
	});

	it("grows arrays with explicit null values", () => {
		const initial = { xs: [1] as (number | null)[] };
		const t = track(structuredClone(initial));
		t.flush();
		t.state.xs.length = 4;
		expect(t.state.xs).toEqual([1, null, null, null]);
		expect(apply(structuredClone(initial), t.flush())).toEqual(t.state);
	});
});

describe("replacing the whole value", () => {
	// The proxy cannot observe `tracker.state = next`: `state` belongs to the
	// tracker, not to the tracked object, so assigning to it swaps the proxy for a
	// plain object and silently stops tracking. Replacement must be a method.
	it("assigning to state emits a base batch and keeps tracking", () => {
		const t = track<Record<string, unknown>>({ p: 1, q: PAD });
		t.flush(); // drain the base batch
		t.state.p = 2;
		t.state = { r: 9, s: "new" };
		const ops = t.flush();
		expect(ops).toEqual([["r", { r: 9, s: "new" }]]);
		expect(isBase(ops)).toBe(true);
		expect(apply({}, ops)).toEqual(t.state);

		t.state.r = 10; // the new value is tracked
		expect(t.flush()).toEqual([["s", ["r"], 10]]);
	});

	it("assigning the tracked root to state rebases without poisoning the tracker", () => {
		const t = track({ value: 1 });
		t.flush();
		const trackedRoot = t.state;
		t.state = trackedRoot;
		expect(t.flush()).toEqual([["r", { value: 1 }]]);
		t.state.value = 2;
		expect(t.flush()).toEqual([["s", ["value"], 2]]);
	});

	it("allows a tracked child self-assignment as a no-op", () => {
		const t = track({ child: { value: 1 } });
		t.flush();
		const child = t.state.child;
		t.state.child = child;
		expect(t.flush()).toEqual([]);
	});

	it("assigning to state discards ops recorded before it", () => {
		// They describe a value that no longer exists.
		const t = track<Record<string, unknown>>({ p: 1, q: PAD });
		t.flush(); // drain the base batch
		t.state.p = 2;
		t.state = { z: 1 };
		expect(t.flush()).toEqual([["r", { z: 1 }]]);
	});

	it("a partial rewrite keeps its ops", () => {
		const t = track<Record<string, unknown>>({ a: "x".repeat(200), b: "y".repeat(200) });
		t.flush(); // drain the base batch
		t.state.a = "p";
		const ops = t.flush();
		expect(isBase(ops)).toBe(false);
		expect(ops).toEqual([["s", ["a"], "p"]]);
	});

	it("rebase() forces a base batch without changing the value", () => {
		// This is the checkpoint. Recovery replays from the last base batch, so a
		// producer must be able to bound that rather than depend on the adaptive
		// size rule, which compares each flush independently.
		const t = track<Record<string, unknown>>({ p: 1, pad: PAD });
		t.flush(); // drain the base batch
		t.rebase();
		const ops = t.flush();
		expect(isBase(ops)).toBe(true);
		expect(apply({}, ops)).toEqual(t.state);
	});

	it("rebase() applies once, not to every later flush", () => {
		const t = track<Record<string, unknown>>({ p: 1, pad: PAD });
		t.flush(); // drain the base batch
		t.rebase();
		t.flush();
		t.state.p = 2;
		expect(t.flush()).toEqual([["s", ["p"], 2]]);
	});
});

describe("the first flush", () => {
	it("is always a base batch", () => {
		// A consumer starts with nothing, so a stream opening with deltas has
		// nothing to apply them to. Requiring the producer to remember would fail
		// at runtime, in the consumer, rather than where the mistake is.
		const t = track<Record<string, unknown>>({ x: 0 });
		t.state.x = 100;
		const ops = t.flush();
		expect(isBase(ops)).toBe(true);
		expect(ops).toEqual([["r", { x: 100 }]]); // carries mutations made before it
	});

	it("is followed by deltas", () => {
		const t = track<Record<string, unknown>>({ x: 0, pad: PAD });
		t.flush();
		t.state.x = 1;
		expect(t.flush()).toEqual([["s", ["x"], 1]]);
	});

	it("emits nothing when untouched", () => {
		// An unmutated tracker has nothing to say; the base batch is owed to a
		// consumer, and there is no consumer until someone flushes.
		const t = track<Record<string, unknown>>({ x: 0 });
		expect(t.dirty).toBe(true);
		expect(t.flush()).toEqual([["r", { x: 0 }]]);
		expect(t.dirty).toBe(false);
		expect(t.flush()).toEqual([]);
	});

	it("discard accepts pending changes into the local baseline", () => {
		const t = track({ x: 0, y: 0 });
		t.flush();
		t.state.x = 1;
		expect(t.dirty).toBe(true);
		t.discard();
		expect(t.dirty).toBe(false);
		expect(t.flush()).toEqual([]);
		t.state.y = 1;
		expect(t.flush()).toEqual([["s", ["y"], 1]]);
	});
});

describe("immutable operation application", () => {
	it("does not mutate a replacement payload targeted by a later operation", () => {
		const replacement = { nested: { value: 1 } };
		const next = applyImmutable<{ nested: { value: number } }>(undefined, [
			["r", replacement],
			["s", ["nested", "value"], 2],
		]);
		expect(replacement.nested.value).toBe(1);
		expect(next.nested.value).toBe(2);
	});
});

describe("apply and fan-out", () => {
	it("adopts an `r` payload rather than copying it", () => {
		// The consumer owns the batch it was handed. Copying every base batch
		// defensively doubles the memory of the one op carrying the whole value.
		//
		// The rule that follows: do not hand one batch to two in-process
		// consumers. This test pins the aliasing so nobody "fixes" it by adding a
		// clone back.
		const t = track<Record<string, unknown>>({ n: 0 });
		const batch = t.flush();
		const a = apply<Record<string, unknown>>(undefined, batch);
		const b = apply<Record<string, unknown>>(undefined, batch);
		a.n = 1;
		expect(b.n).toBe(1);
	});

	it("does not alias the producer", () => {
		const t = track<Record<string, unknown>>({ x: 0 });
		const replica = apply<Record<string, unknown>>(undefined, t.flush());
		t.state.x = 999;
		t.flush();
		expect(replica.x).toBe(0);
	});

	it("adopts assigned values without cloning them", () => {
		const t = track<{ item?: { value: number } }>({});
		const replica = apply<{ item?: { value: number } }>(undefined, t.flush());
		const supplied = { value: 0 };
		t.state.item = supplied;
		t.state.item.value = 1;
		expect(supplied.value).toBe(1);
		expect(apply(replica, t.flush())).toEqual(t.state);
	});

	it("does not alias pushed values with an in-process consumer", () => {
		const t = track({ xs: [] as { value: number }[] });
		const replica = apply<{ xs: { value: number }[] }>(undefined, t.flush());
		t.state.xs.push({ value: 1 });
		const next = apply(replica, t.flush());
		next.xs[0]!.value = 2;
		expect(t.state.xs[0]!.value).toBe(1);
	});

	it("folds a whole stream without a base-batch branch", () => {
		// `apply` handles `r` by replacing, and tolerates an undefined target,
		// so a consumer needs no isBase check and no clone of its own.
		const t = track({ x: 0, l: [] as string[] });
		const enc = encoder();
		const dec = decoder();
		let replica: unknown;
		const send = () => {
			replica = apply(replica, dec.decode(enc.encode(t.flush())));
		};

		t.state.x = 100;
		t.state.l.push("xyz");
		send();
		t.state.x = 101;
		send();
		expect(replica).toEqual(t.state);
	});
});

describe("flush-time minimization", () => {
	// Mutations only mark dirty paths. Flush compares the last published baseline
	// with the current value, so repeated writes never accumulate pending ops.
	type DeadOpState = { a: Record<string, JsonValue>; x?: number; y?: number };
	const run = (mutate: (state: DeadOpState) => void, init: DeadOpState = { a: { b: 1 }, x: 1, y: 2 }) => {
		const t = track(structuredClone(init));
		t.flush(); // drain the base batch
		mutate(t.state);
		return t.flush();
	};

	it("collapses repeated writes to one field", () => {
		expect(
			run((s) => {
				s.x = 1;
				s.x = 2;
				s.x = 3;
			}),
		).toEqual([["s", ["x"], 3]]);
	});

	it("drops a write superseded by a later, non-adjacent one", () => {
		expect(
			run((s) => {
				s.x = 10;
				s.y = 20;
				s.x = 30;
			}),
		).toEqual([
			["s", ["y"], 20],
			["s", ["x"], 30],
		]);
	});

	it("drops a child write when the parent is replaced after it", () => {
		expect(
			run((s) => {
				s.a.b = 99;
				s.a = { c: 5 };
			}),
		).toEqual([
			["s", ["a", "c"], 5],
			["d", ["a", "b"]],
		]);
	});

	it("folds a child write into its pending parent replacement", () => {
		expect(
			run((s) => {
				s.a = { b: 1 };
				s.a.b = 7;
			}),
		).toEqual([["s", ["a", "b"], 7]]);
	});

	it("collapses set-then-delete to the delete", () => {
		expect(
			run((s) => {
				s.x = 5;
				delete s.x;
			}),
		).toEqual([["d", ["x"]]]);
	});

	it("collapses delete-then-set to the final value", () => {
		// Delta replication preserves JSON values, not object insertion order.
		expect(
			run((s) => {
				delete s.x;
				s.x = 5;
			}),
		).toEqual([["s", ["x"], 5]]);
	});

	it("derives an append after delete-then-recreate", () => {
		const t = track<{ x?: string; y: number }>({ x: "", y: 1 });
		t.flush();
		delete t.state.x;
		t.state.x = "ab";
		t.state.x += "cd";
		expect(t.flush()).toEqual([["a", ["x"], "abcd"]]);
	});

	it("is linear in the number of ops", () => {
		// The naive formulation compares every op against every dominator, which
		// is quadratic and degrades on exactly the wide flush this pass cleans up.
		const wide = (n: number) => {
			const root: Record<string, number> = {};
			for (let i = 0; i < n; i++) root[`f${i}`] = i;
			const t = track(root);
			t.flush(); // drain the base batch
			const started = performance.now();
			for (let i = 0; i < n; i++) t.state[`f${i}`] = i + 1;
			t.flush();
			return performance.now() - started;
		};
		wide(200); // warm
		const small = Math.max(wide(250), 0.1);
		const large = wide(2500);
		expect(large / small).toBeLessThan(40); // linear would be ~10x
	});

	it("collapses a pathological redundant producer", () => {
		const t = track<{ a: Record<string, JsonValue>; x: number }>({ a: { b: 1 }, x: 1 });
		t.flush(); // drain the base batch
		for (let i = 0; i < 2000; i++) {
			t.state.x = i;
			t.state.a.b = i;
		}
		t.state.a = { done: true };
		const ops = t.flush();
		expect(ops).toHaveLength(3);
		expect(apply({ a: { b: 1 }, x: 1 }, ops)).toEqual(t.state);
	});
});

describe("flush", () => {
	it("drops everything before a replacement", () => {
		const t = track([1, 2]);
		t.flush(); // drain the base batch
		t.state.push(3);
		t.state.splice(0, 3, 7);
		expect(t.flush()).toEqual([["r", [7]]]);
	});

	it("keeps the prefix when the replacement is nested", () => {
		// `s` on a subtree is not a root replacement, so earlier ops stay live.
		const t = track({ a: 1, xs: [1, 2, 3], pad: PAD });
		t.flush(); // drain the base batch
		t.state.a = 2;
		t.state.xs.splice(0, 3, 9);
		expect(t.flush()).toEqual([
			["s", ["a"], 2],
			["s", ["xs"], [9]],
		]);
	});

	it("rejects a constructor walk", () => {
		// ({}).constructor.constructor is Function — the classic escape ladder.
		expect(() => apply({}, JSON.parse('[["s",["constructor","prototype","gadget"],true]]'))).toThrow();
		expect(({} as Record<string, unknown>).gadget).toBeUndefined();
	});

	it("rejects a forbidden path reached through an interned id", () => {
		const wire = [
			["#", 0, ["__proto__", "w"]],
			["s", 0, true],
		] as unknown as WireOp[];
		expect(() => decoder().decode(wire)).toThrow();
	});

	it("does not run an inherited setter", () => {
		Object.defineProperty(Object.prototype, "trap", {
			get() {
				throw new Error("inherited getter ran");
			},
			configurable: true,
		});
		try {
			expect(() => apply({}, [["s", ["trap"], 1]])).not.toThrow();
		} finally {
			delete (Object.prototype as Record<string, unknown>).trap;
		}
	});

	it("allows a reserved name as a VALUE key", () => {
		// Reserved as segments, not as values.
		const out = apply({}, [["s", ["a"], JSON.parse('{"__proto__":{"z":1}}')]]);
		expect(({} as Record<string, unknown>).z).toBeUndefined();
		expect(out).toBeDefined();
	});

	it("clones and reads reserved value keys without invoking prototype setters", () => {
		const t = track({ value: JSON.parse('{"__proto__":{"z":1}}') as JsonValue });
		const out = apply<{ value: JsonValue }>(undefined, t.flush());
		expect(Object.hasOwn(out.value as object, "__proto__")).toBe(true);
		expect(JSON.parse(JSON.stringify(t.state))).toEqual({ value: JSON.parse('{"__proto__":{"z":1}}') });
		expect(() => {
			((t.state.value as Record<string, JsonValue>).__proto__ as Record<string, JsonValue>).z = 2;
		}).toThrow(/unsafe path/);
		expect(({} as Record<string, unknown>).z).toBeUndefined();
	});
});

describe("safety: array indices", () => {
	// An index may address an existing element or append exactly one past the end.
	// Not an arbitrary cap: a sparse array does not survive a JSON round trip, so
	// arr[7] = x on a length-3 array already produces unreplicable state.
	it("writes an existing index", () => {
		expect(apply({ xs: [1, 2, 3] }, [["s", ["xs", 1], 9]])).toEqual({ xs: [1, 9, 3] });
	});
	it("appends one past the end", () => {
		expect(apply({ xs: [1, 2, 3] }, [["s", ["xs", 3], 9]])).toEqual({ xs: [1, 2, 3, 9] });
	});
	it("rejects a gap", () => {
		expect(() => apply({ xs: [1, 2, 3] }, [["s", ["xs", 5], 9]])).toThrow();
	});
	it("rejects a huge index", () => {
		// Would otherwise allocate 4.29 billion entries from one op.
		expect(() => apply({ xs: [] }, [["s", ["xs", 4_294_967_290], 1]])).toThrow();
	});
	it("rejects string-spelled array indices at the consumer", () => {
		expect(() => apply({ xs: [1, 2, 3] }, [["s", ["xs", "7"], 9]])).toThrow();
		expect(() => apply({ xs: ["a"] }, [["a", ["xs", "0"], "b"]])).toThrow();
	});
	it("rejects sparse writes at the producer", () => {
		const t = track({ xs: [1, 2, 3] });
		t.flush();
		expect(() => {
			t.state.xs[5] = 9;
		}).toThrow();
		expect(t.state.xs).toEqual([1, 2, 3]);
	});
	it("rejects array deletes at the producer", () => {
		const t = track({ xs: [1, 2, 3] });
		t.flush();
		expect(() => {
			delete t.state.xs[1];
		}).toThrow();
		expect(t.state.xs).toEqual([1, 2, 3]);
	});
	it("rejects undefined array elements at the producer", () => {
		const t = track<{ xs: (number | undefined)[] }>({ xs: [1, 2, 3] });
		t.flush();
		expect(() => {
			t.state.xs[1] = undefined;
		}).toThrow();
		expect(t.state.xs).toEqual([1, 2, 3]);
	});
	it("allows explicit growth with nulls", () => {
		expect(apply({ xs: [1] }, [["p", ["xs"], 1, 0, [null, null, 9]]])).toEqual({ xs: [1, null, null, 9] });
	});
	it("rejects deleting one past an array's end", () => {
		expect(() => apply({ xs: [1] }, [["d", ["xs", 1]]])).toThrow();
	});
	it("applies large splice payloads without spreading them at once", () => {
		const items = Array<JsonValue>(300_000).fill(null);
		const result = apply({ xs: [] as JsonValue[] }, [["p", ["xs"], 0, 0, items]]);
		expect(result.xs).toHaveLength(items.length);
	});
});

describe("safety: op structure", () => {
	// The CVE-2025-55182 lesson: a decoder must not trust tuple shape.
	it("rejects an unknown verb rather than skipping it", () => {
		// Silently skipping is how a newer producer's op vanishes and a replica drifts.
		expect(() => apply({ a: 1 }, [["ZZZ", ["a"], 9] as never])).toThrow();
	});
	it("rejects non-array splice items", () => {
		// Unvalidated, this spreads a string: ["n","o","t","-","a",…]
		expect(() => apply({ xs: [1] }, [["p", ["xs"], 0, 0, "not-an-array"] as never])).toThrow();
	});
	it("rejects a string path", () => {
		// Unvalidated, "a".slice(0,-1) is "", so it resolved to the ROOT and wrote.
		expect(() => apply({ a: 1 }, [["s", "a", 9] as never])).toThrow();
	});
	it("rejects a non-tuple op", () => {
		expect(() => apply({ a: 1 }, [{ op: "s" } as never])).toThrow();
		expect(() => apply({ a: 1 }, [null as never])).toThrow();
	});
	it("rejects append to a missing or non-string value", () => {
		expect(() => apply({ a: 1 }, [["a", ["missing"], "x"]])).toThrow();
		expect(() => apply({ a: 1 }, [["a", ["a"], "x"]])).toThrow();
	});
	it("rejects negative truncation", () => {
		expect(() => apply({ a: "abc" }, [["t", ["a"], -1]])).toThrow();
		expect(() => decoder().decode([["t", ["a"], -1]])).toThrow();
	});
	it("clamps a splice remove past the end, as Array.prototype.splice does", () => {
		// Deterministic and identical on both sides — not a hole.
		expect(apply({ xs: [1, 2] }, [["p", ["xs"], 0, 1e9, []]])).toEqual({ xs: [] });
	});
});

describe("tracker proxy boundaries", () => {
	it("rejects descriptor and object-shape bypasses", () => {
		const t = track<Record<string, unknown>>({ pad: PAD });
		t.flush();
		expect(() => Object.defineProperty(t.state, "g", { value: 42, enumerable: true })).toThrow(/assignment/);
		expect(() => Object.setPrototypeOf(t.state, null)).toThrow(/setPrototypeOf/);
		expect(() => Object.preventExtensions(t.state)).toThrow(/preventExtensions/);
		expect(t.state).toEqual({ pad: PAD });
		expect(t.flush()).toEqual([]);
	});

	it("accepts a value that merely looks like an op", () => {
		const t = track<Record<string, unknown>>({ pad: PAD });
		t.flush();
		t.state.x = ["r", { evil: true }];
		expect(t.flush()).toEqual([["s", ["x"], ["r", { evil: true }]]]);
	});
});

describe("assertions", () => {
	it("assertValidOp accepts decoded ops and rejects wire forms", () => {
		// Validating Op against the wire grammar would be laxer than the type: a
		// two-element ["s", value] would pass, and apply would read the value as a
		// path. Each vocabulary gets the validator that matches it.
		for (const op of [
			["r", { a: 1 }],
			["s", ["a"], 1],
			["d", ["a"]],
			["a", ["a"], "x"],
			["t", ["a"], 2],
			["p", ["a"], 0, 0, []],
		] as never[]) {
			expect(() => assertValidOp(op)).not.toThrow();
		}
		for (const wireOnly of [
			["s", 1],
			["d"],
			["a", "x"],
			["t", 2],
			["p", 0, 0, []],
			["#", 0, ["a"]],
			["s", 0, 1],
		] as never[]) {
			expect(() => assertValidOp(wireOnly)).toThrow();
			expect(() => assertValidWireOp(wireOnly)).not.toThrow();
		}
	});

	it("does not recursively inspect operation payloads", () => {
		expect(() => assertValidOp(["s", ["value"], new Map()] as never)).not.toThrow();
		expect(() => assertValidWireOp(["r", new Date()] as never)).not.toThrow();
	});
});

describe("codec: path interning and arity omission", () => {
	// One pair per stream. The table spans a whole subscription or file, so a
	// second consumer joining later needs its own encoder.
	const roundTrip = (batches: Op[][]) => {
		const enc = encoder();
		const dec = decoder();
		return batches.map((ops) => dec.decode(enc.encode(ops)));
	};

	it("round-trips a stream exactly", () => {
		const t = track({ a: { deep: "" }, b: { deep: "" } });
		t.flush(); // drain the base batch
		const batches: Op[][] = [];
		for (let i = 0; i < 6; i++) {
			t.state.a.deep += `x${i}`;
			t.state.b.deep += `y${i}`;
			batches.push(t.flush());
		}
		expect(roundTrip(batches)).toEqual(batches);
	});

	it("interns on second use, not first", () => {
		const enc = encoder();
		const p = ["a", "deep"] as const;
		const first = enc.encode([["a", p, "1"]]);
		const second = enc.encode([["a", p, "2"]]);
		expect(first).toEqual([["a", p, "1"]]); // inline
		expect(second).toEqual([
			["#", 0, p],
			["a", 0, "2"],
		]); // define, then use
	});

	it("omits the path when it repeats", () => {
		const enc = encoder();
		const p = ["a"] as const;
		expect(
			enc.encode([
				["s", p, 1],
				["s", p, 2],
			]),
		).toEqual([
			["s", p, 1],
			["s", 2],
		]);
	});

	it("does not collide paths containing null characters", () => {
		const first = ["a\u0000b"] as const;
		const second = ["a", "b"] as const;
		const ops: Op[] = [
			["s", first, 1],
			["s", second, 2],
		];
		expect(decoder().decode(encoder().encode(ops))).toEqual(ops);
	});

	it("rejects a short form without a previous path", () => {
		expect(() => decoder().decode([["a", "x"]])).toThrow();
	});

	it("clears decoder ids on a base batch", () => {
		const dec = decoder();
		dec.decode([
			["#", 0, ["a"]],
			["a", 0, "1"],
		]);
		dec.decode([["r", { a: "" }]]);
		expect(() => dec.decode([["a", 0, "2"]])).toThrow();
	});

	it("resets the table on a base batch, so recovery is self-contained", () => {
		// A reader replays from the LAST base batch with a fresh decoder. Ids
		// defined before it were never seen, so keeping them breaks recovery with
		// an unresolvable path id.
		const enc = encoder();
		const p = ["a", "deep"] as const;
		enc.encode([["a", p, "1"]]);
		enc.encode([["a", p, "2"]]); // id 0 assigned
		const base = enc.encode([["r", { a: { deep: "x" } }]]);
		const after = enc.encode([["a", p, "3"]]);
		expect(base).toEqual([["r", { a: { deep: "x" } }]]);
		expect(after).toEqual([["a", p, "3"]]); // inline again

		const dec = decoder();
		expect(() => dec.decode(base)).not.toThrow();
		expect(dec.decode(after)).toEqual([["a", p, "3"]]);
	});

	it("survives recovery from the last base batch", () => {
		const enc = encoder();
		const t = track({ a: { deep: "" }, b: { deep: "" } });
		t.flush(); // drain the base batch
		const wire: WireOp[][] = [];
		for (let i = 0; i < 8; i++) {
			t.state.a.deep += `x${i}`;
			t.state.b.deep += `y${i}`;
			if (i === 5) t.rebase();
			wire.push(enc.encode(t.flush()));
		}
		const lastBase = wire.map(isBase).lastIndexOf(true);
		const dec = decoder();
		let replica: unknown;
		for (const w of wire.slice(lastBase)) {
			const ops = dec.decode(w);
			replica = replica === undefined ? structuredClone((ops[0] as ["r", unknown])[1]) : apply(replica, ops);
		}
		expect(replica).toEqual(t.state);
	});

	it("round-trips random streams", () => {
		for (let round = 0; round < 300; round++) {
			const t = track<{ a: { p: string; q: string }; b: JsonValue[]; c?: number }>({
				a: { p: "", q: "" },
				b: [],
				c: 0,
			});
			t.flush(); // drain the base batch
			const batches: Op[][] = [];
			for (let i = 0; i < 8; i++) {
				const r = Math.random();
				if (r < 0.3) t.state.a.p += "x";
				else if (r < 0.5) t.state.a.q += "y";
				else if (r < 0.65) t.state.b.push(i);
				else if (r < 0.8) t.state.c = i;
				else if (r < 0.9) delete t.state.c;
				else t.rebase();
				const ops = t.flush();
				if (ops.length > 0) batches.push(ops);
			}
			expect(roundTrip(batches)).toEqual(batches);
		}
	});
});

describe("property: flush-time tracking", () => {
	it("converges across mixed nested writes, replacements, and array mutations", () => {
		type State = { rows: { text: string; count: number }[]; meta: { revision: number } };
		let seed = 0x5eed1234;
		const next = (): number => {
			seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
			return seed;
		};
		for (let round = 0; round < 100; round++) {
			const initial: State = {
				rows: [
					{ text: "a", count: 0 },
					{ text: "b", count: 0 },
				],
				meta: { revision: 0 },
			};
			const tracker = track(structuredClone(initial));
			const enc = encoder();
			const dec = decoder();
			let replica = apply<State>(undefined, dec.decode(enc.encode(tracker.flush())));
			for (let step = 0; step < 60; step++) {
				const rows = tracker.state.rows;
				switch (next() % 10) {
					case 0:
						if (rows.length > 0) rows[next() % rows.length]!.text += String.fromCharCode(97 + (next() % 26));
						break;
					case 1:
						if (rows.length > 0) rows[next() % rows.length]!.count++;
						break;
					case 2:
						rows.push({ text: `tail-${round}-${step}`, count: step });
						break;
					case 3:
						if (rows.length > 0) rows.pop();
						break;
					case 4:
						rows.unshift({ text: `head-${round}-${step}`, count: step });
						break;
					case 5:
						if (rows.length > 0) rows.shift();
						break;
					case 6: {
						const index = next() % (rows.length + 1);
						const remove = rows.length > 0 && next() % 2 === 0 ? 1 : 0;
						rows.splice(index, remove, { text: `mid-${round}-${step}`, count: step });
						break;
					}
					case 7: {
						const replacement = JSON.parse(JSON.stringify(rows)) as State["rows"];
						if (replacement.length > 0) replacement[0]!.text += "r";
						if (next() % 2 === 0) replacement.push({ text: "replacement-tail", count: step });
						tracker.state.rows = replacement;
						break;
					}
					case 8:
						tracker.state.meta = { revision: tracker.state.meta.revision + 1 };
						break;
					default:
						if (rows.length > 1) rows.reverse();
				}
				if (tracker.state.rows.length > 12) tracker.state.rows.splice(0, tracker.state.rows.length - 12);
				if (next() % 5 === 0) {
					replica = apply(replica, dec.decode(enc.encode(tracker.flush())));
					expect(replica).toEqual(tracker.state);
				}
			}
			replica = apply(replica, dec.decode(enc.encode(tracker.flush())));
			expect(replica).toEqual(tracker.state);
		}
	});
});

describe("property: random round-trip", () => {
	// 3000 random sequences found the root-splice hole on the first run, before any
	// hand-written case did.
	const rnd = (d = 0): unknown => {
		const r = Math.random();
		if (d > 2 || r < 0.3) return Math.floor(Math.random() * 5);
		if (r < 0.45) return ["x", "y", null, true][Math.floor(Math.random() * 4)];
		if (r < 0.7) return Array.from({ length: Math.floor(Math.random() * 4) }, () => rnd(d + 1));
		const o: Record<string, unknown> = {};
		for (const k of ["a", "b", "c"]) if (Math.random() < 0.6) o[k] = rnd(d + 1);
		return o;
	};

	it("a replica always matches the producer", () => {
		let checked = 0;
		for (let i = 0; i < 3000; i++) {
			const base = rnd();
			if (typeof base !== "object" || base === null) continue;
			const t = track(structuredClone(base) as object);
			t.flush(); // drain the base batch
			const next = rnd();
			if (Array.isArray(t.state) && Array.isArray(next)) {
				(t.state as unknown[]).splice(0, (t.state as unknown[]).length, ...next);
			} else if (!Array.isArray(t.state) && typeof next === "object" && next !== null && !Array.isArray(next)) {
				const s = t.state as Record<string, unknown>;
				for (const k of Object.keys(s)) if (!(k in next)) delete s[k];
				for (const [k, v] of Object.entries(next)) s[k] = v;
			} else continue;
			expect(apply(structuredClone(base), t.flush())).toEqual(t.state);
			checked++;
		}
		// Most random pairs are shape-incompatible and skipped; this only guards
		// against the loop silently checking nothing.
		expect(checked).toBeGreaterThan(200);
	});
});
