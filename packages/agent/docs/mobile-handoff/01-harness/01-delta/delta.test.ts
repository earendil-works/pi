import { describe, expect, it } from "vitest";
import { apply, assertJsonValue, assertValidOp, assertValidWireOp, decoder, encoder, isBase, overlap, track, type Op, type WireOp } from "./delta-impl.ts";

const PAD = "p".repeat(400);   // see "adaptive emission": a delta must be able to win

describe("tracker: intent", () => {
	it("records an append, not a replacement", () => {
		const t = track({ s: "", pad: PAD });
		t.flush();   // drain the base batch
		t.state.s += "ab";
		t.state.s += "cd";
		const ops = t.flush();
		expect(ops).toEqual([["a", ["s"], "abcd"]]);
		expect(apply({ s: "", pad: PAD }, ops)).toEqual({ s: "abcd", pad: PAD });
	});

	it("recovers truncate+append from a rolling window", () => {
		// The case every effect-recording library degrades to a whole-value set.
		const t = track({ s: "abcdefgh", pad: PAD });
		t.flush();   // drain the base batch
		t.state.s = t.state.s.slice(3) + "xyz";
		const ops = t.flush();
		expect(ops).toEqual([["t", ["s"], 3], ["a", ["s"], "xyz"]]);
		expect(apply({ s: "abcdefgh", pad: PAD }, ops)).toEqual({ s: "defghxyz", pad: PAD });
	});

	it("records array intent as one splice", () => {
		const t = track({ xs: [1, 2], pad: PAD });
		t.flush();   // drain the base batch
		t.state.xs.push(3);
		expect(t.flush()).toEqual([["p", ["xs"], 2, 0, [3]]]);
	});

	it("normalises undefined to a delete", () => {
		const t = track({ a: 1, pad: PAD });
		t.flush();   // drain the base batch
		(t.state as Record<string, unknown>).a = undefined;
		expect(t.flush()).toEqual([["d", ["a"]]]);
	});
});

describe("tracker: root ops", () => {
	it("splices a value that is itself an array", () => {
		const t = track([1, 2, 3, PAD]);
		t.flush();   // drain the base batch
		t.state.push(4);
		const ops = t.flush();
		expect(ops).toEqual([["p", [], 4, 0, [4]]]);
		expect(apply([1, 2, 3, PAD], ops)).toEqual([1, 2, 3, PAD, 4]);
	});

	it("normalises a splice covering the whole root to a replacement", () => {
		const t = track([1, 2, 3]);
		t.flush();   // drain the base batch
		t.state.splice(0, 3, 9);
		const ops = t.flush();
		expect(ops).toEqual([["r", [9]]]);
		expect(isBase(ops)).toBe(true);
	});

	it("normalises a nested splice-all to a set, not a replacement", () => {
		const t = track({ xs: [1, 2, 3], pad: PAD });
		t.flush();   // drain the base batch
		t.state.xs.splice(0, 3, 9);
		expect(t.flush()).toEqual([["s", ["xs"], [9]]]);
	});

	it("normalises length = 0 on the root", () => {
		const t = track([1, 2, 3]);
		t.flush();   // drain the base batch
		t.state.length = 0;
		const ops = t.flush();
		expect(ops).toEqual([["r", []]]);
		expect(apply([1, 2, 3], ops)).toEqual([]);
	});
});

describe("replacing the whole value", () => {
	// The proxy cannot observe `tracker.state = next`: `state` belongs to the
	// tracker, not to the tracked object, so assigning to it swaps the proxy for a
	// plain object and silently stops tracking. Replacement must be a method.
	it("assigning to state emits a base batch and keeps tracking", () => {
		const t = track<Record<string, unknown>>({ p: 1, q: PAD });
		t.flush();   // drain the base batch
		t.state.p = 2;
		t.state = { r: 9, s: "new" };
		const ops = t.flush();
		expect(ops).toEqual([["r", { r: 9, s: "new" }]]);
		expect(isBase(ops)).toBe(true);
		expect(apply({}, ops)).toEqual(t.target);

		t.state.r = 10;                       // the new value is tracked
		expect(t.flush()).toEqual([["s", ["r"], 10]]);
	});

	it("assigning to state discards ops recorded before it", () => {
		// They describe a value that no longer exists.
		const t = track<Record<string, unknown>>({ p: 1, q: PAD });
		t.flush();   // drain the base batch
		t.state.p = 2;
		t.state = { z: 1 };
		expect(t.flush()).toEqual([["r", { z: 1 }]]);
	});

	it("a partial rewrite keeps its ops", () => {
		const t = track<Record<string, unknown>>({ a: "x".repeat(200), b: "y".repeat(200) });
		t.flush();   // drain the base batch
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
		t.flush();   // drain the base batch
		t.rebase();
		const ops = t.flush();
		expect(isBase(ops)).toBe(true);
		expect(apply({}, ops)).toEqual(t.target);
	});

	it("rebase() applies once, not to every later flush", () => {
		const t = track<Record<string, unknown>>({ p: 1, pad: PAD });
		t.flush();   // drain the base batch
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
		expect(ops).toEqual([["r", { x: 100 }]]);   // carries mutations made before it
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
		expect(t.flush()).toEqual([["r", { x: 0 }]]);
		expect(t.flush()).toEqual([]);
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
		const a = apply(undefined, batch) as Record<string, unknown>;
		const b = apply(undefined, batch) as Record<string, unknown>;
		a.n = 1;
		expect(b.n).toBe(1);
	});

	it("does not alias the producer", () => {
		const t = track<Record<string, unknown>>({ x: 0 });
		const replica = apply(undefined, t.flush()) as Record<string, unknown>;
		t.state.x = 999;
		t.flush();
		expect(replica.x).toBe(0);
	});

	it("folds a whole stream without a base-batch branch", () => {
		// `apply` handles `r` by replacing, and tolerates an undefined target,
		// so a consumer needs no isBase check and no clone of its own.
		const t = track<Record<string, any>>({ x: 0, l: [] as string[] });
		const enc = encoder();
		const dec = decoder();
		let replica: unknown;
		const send = () => { replica = apply(replica, dec.decode(enc.encode(t.flush()))); };

		t.state.x = 100;
		t.state.l.push("xyz");
		send();
		t.state.x = 101;
		send();
		expect(replica).toEqual(t.target);
	});
});

describe("dead-op elimination", () => {
	// Ops apply in order, so an op is dead if a later one overwrites the whole
	// subtree it lives in. Only s/d/r dominate; a/t/p modify what is there.
	const run = (mutate: (s: any) => void, init: any = { a: { b: 1 }, x: 1, y: 2 }) => {
		const t = track<any>(structuredClone(init));
		t.flush();   // drain the base batch
		mutate(t.state);
		return t.flush();
	};

	it("collapses repeated writes to one field", () => {
		expect(run((s) => { s.x = 1; s.x = 2; s.x = 3; })).toEqual([["s", ["x"], 3]]);
	});

	it("drops a write superseded by a later, non-adjacent one", () => {
		expect(run((s) => { s.x = 10; s.y = 20; s.x = 30; }))
			.toEqual([["s", ["y"], 20], ["s", ["x"], 30]]);
	});

	it("drops a child write when the parent is replaced after it", () => {
		expect(run((s) => { s.a.b = 99; s.a = { c: 5 }; })).toEqual([["s", ["a"], { c: 5 }]]);
	});

	it("keeps a child write that follows the parent replacement", () => {
		expect(run((s) => { s.a = { b: 1 }; s.a.b = 7; }))
			.toEqual([["s", ["a"], { b: 1 }], ["s", ["a", "b"], 7]]);
	});

	it("collapses set-then-delete to the delete", () => {
		expect(run((s) => { s.x = 5; delete s.x; })).toEqual([["d", ["x"]]]);
	});

	it("keeps delete-then-set, to preserve key position", () => {
		// Dropping the delete would leave the key in its original slot while the
		// producer moved it to the end. Same value, different serialisation.
		expect(run((s) => { delete s.x; s.x = 5; })).toEqual([["d", ["x"]], ["s", ["x"], 5]]);
	});

	it("is linear in the number of ops", () => {
		// The naive formulation compares every op against every dominator, which
		// is quadratic and degrades on exactly the wide flush this pass cleans up.
		const wide = (n: number) => {
			const root: Record<string, number> = {};
			for (let i = 0; i < n; i++) root[`f${i}`] = i;
			const t = track(root);
			t.flush();   // drain the base batch
			const started = performance.now();
			for (let i = 0; i < n; i++) t.state[`f${i}`] = i + 1;
			t.flush();
			return performance.now() - started;
		};
		wide(200);                                    // warm
		const small = Math.max(wide(250), 0.1);
		const large = wide(2500);
		expect(large / small).toBeLessThan(40);       // linear would be ~10x
	});

	it("collapses a pathological redundant producer", () => {
		const t = track<any>({ a: { b: 1 }, x: 1 });
		t.flush();   // drain the base batch
		for (let i = 0; i < 2000; i++) { t.state.x = i; t.state.a.b = i; }
		t.state.a = { done: true };
		expect(t.flush()).toHaveLength(2);
	});
});

describe("flush", () => {
	it("drops everything before a replacement", () => {
		const t = track([1, 2]);
		t.flush();   // drain the base batch
		t.state.push(3);
		t.state.splice(0, 3, 7);
		expect(t.flush()).toEqual([["r", [7]]]);
	});

	it("keeps the prefix when the replacement is nested", () => {
		// `s` on a subtree is not a root replacement, so earlier ops stay live.
		const t = track({ a: 1, xs: [1, 2, 3], pad: PAD });
		t.flush();   // drain the base batch
		t.state.a = 2;
		t.state.xs.splice(0, 3, 9);
		expect(t.flush()).toEqual([["s", ["a"], 2], ["s", ["xs"], [9]]]);
	});

	it("rejects a constructor walk", () => {
		// ({}).constructor.constructor is Function — the classic escape ladder.
		expect(() => apply({}, JSON.parse('[["s",["constructor","prototype","gadget"],true]]'))).toThrow();
		expect(({} as Record<string, unknown>).gadget).toBeUndefined();
	});

	it("rejects a forbidden path reached through an interned id", () => {
		const dict = new Map<number, readonly (string | number)[]>([[0, ["__proto__", "w"]]]);
		expect(() => apply({}, [["s", 0, true]], (id) => dict.get(id)!)).toThrow();
	});

	it("does not run an inherited setter", () => {
		Object.defineProperty(Object.prototype, "trap", {
			get() { throw new Error("inherited getter ran"); },
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
	it("allows explicit growth with nulls", () => {
		expect(apply({ xs: [1] }, [["p", ["xs"], 1, 0, [null, null, 9]]])).toEqual({ xs: [1, null, null, 9] });
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
	it("clamps a splice remove past the end, as Array.prototype.splice does", () => {
		// Deterministic and identical on both sides — not a hole.
		expect(apply({ xs: [1, 2] }, [["p", ["xs"], 0, 1e9, []]])).toEqual({ xs: [] });
	});
});

describe("safety: what a facet can put on the wire", () => {
	// A facet cannot forge an op — it mutates plain objects and the tracker builds
	// the tuples. Values and keys are the leak, and structuredClone is NOT a JSON
	// check: it clones a Map happily, and the op then carries {} while the producer
	// keeps a real Map.
	const rejects = (name: string, mutate: (s: Record<string, unknown>) => void) =>
		it(`rejects ${name}`, () => {
			const t = track<Record<string, unknown>>({ pad: PAD });
			t.flush();   // drain the base batch
			expect(() => mutate(t.state)).toThrow();
		});

	rejects("a function", (s) => { s.f = () => {}; });
	rejects("a Map", (s) => { s.m = new Map([[1, 2]]); });
	rejects("a Date", (s) => { s.d = new Date(0); });
	rejects("a BigInt", (s) => { s.b = 1n; });
	rejects("a cycle", (s) => { const a: Record<string, unknown> = {}; a.self = a; s.c = a; });
	rejects("a symbol key", (s) => { s[Symbol("k") as unknown as string] = 1; });

	it("allows a getter on state, recording the computed result", () => {
		const t = track<Record<string, unknown>>({ pad: PAD });
		t.flush();   // drain the base batch
		Object.defineProperty(t.target, "g", { get: () => 42, enumerable: true });
		t.state.x = 1;
		expect(t.flush()).toEqual([["s", ["x"], 1]]);
	});

	it("accepts a value that merely looks like an op", () => {
		// Nested inside ["s", path, value]; nothing flattens, so it cannot be read
		// as a top-level op.
		const t = track<Record<string, unknown>>({ pad: PAD });
		t.flush();   // drain the base batch
		t.state.x = ["r", { evil: true }];
		expect(t.flush()).toEqual([["s", ["x"], ["r", { evil: true }]]]);
	});
});

describe("assertions", () => {
	it("assertJsonValue rejects non-JSON", () => {
		for (const bad of [new Map(), new Set(), new Date(), /re/, () => {}, Number.NaN, Infinity]) {
			expect(() => assertJsonValue(bad)).toThrow();
		}
		for (const good of [null, true, 1, "s", [1, "a"], { a: { b: [null] } }]) {
			expect(() => assertJsonValue(good)).not.toThrow();
		}
	});
	it("assertValidOp accepts decoded ops and rejects wire forms", () => {
		// Validating Op against the wire grammar would be laxer than the type: a
		// two-element ["s", value] would pass, and apply would read the value as a
		// path. Each vocabulary gets the validator that matches it.
		for (const op of [
			["r", { a: 1 }], ["s", ["a"], 1], ["d", ["a"]],
			["a", ["a"], "x"], ["t", ["a"], 2], ["p", ["a"], 0, 0, []],
		] as never[]) {
			expect(() => assertValidOp(op)).not.toThrow();
		}
		for (const wireOnly of [["s", 1], ["d"], ["a", "x"], ["t", 2], ["p", 0, 0, []], ["#", 0, ["a"]], ["s", 0, 1]] as never[]) {
			expect(() => assertValidOp(wireOnly)).toThrow();
			expect(() => assertValidWireOp(wireOnly)).not.toThrow();
		}
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
		const t = track<Record<string, any>>({ a: { deep: "" }, b: { deep: "" } });
		t.flush();   // drain the base batch
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
		expect(first).toEqual([["a", p, "1"]]);                     // inline
		expect(second).toEqual([["#", 0, p], ["a", 0, "2"]]);       // define, then use
	});

	it("omits the path when it repeats", () => {
		const enc = encoder();
		const p = ["a"] as const;
		expect(enc.encode([["s", p, 1], ["s", p, 2]])).toEqual([["s", p, 1], ["s", 2]]);
	});

	it("resets the table on a base batch, so recovery is self-contained", () => {
		// A reader replays from the LAST base batch with a fresh decoder. Ids
		// defined before it were never seen, so keeping them breaks recovery with
		// an unresolvable path id.
		const enc = encoder();
		const p = ["a", "deep"] as const;
		enc.encode([["a", p, "1"]]);
		enc.encode([["a", p, "2"]]);                                 // id 0 assigned
		const base = enc.encode([["r", { a: { deep: "x" } }]]);
		const after = enc.encode([["a", p, "3"]]);
		expect(base).toEqual([["r", { a: { deep: "x" } }]]);
		expect(after).toEqual([["a", p, "3"]]);                      // inline again

		const dec = decoder();
		expect(() => dec.decode(base)).not.toThrow();
		expect(dec.decode(after)).toEqual([["a", p, "3"]]);
	});

	it("survives recovery from the last base batch", () => {
		const enc = encoder();
		const t = track<Record<string, any>>({ a: { deep: "" }, b: { deep: "" } });
		t.flush();   // drain the base batch
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
			replica = replica === undefined
				? structuredClone((ops[0] as ["r", unknown])[1])
				: apply(replica, ops);
		}
		expect(replica).toEqual(t.target);
	});

	it("round-trips random streams", () => {
		for (let round = 0; round < 300; round++) {
			const t = track<Record<string, any>>({ a: { p: "", q: "" }, b: [] as unknown[], c: 0 });
			t.flush();   // drain the base batch
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
			t.flush();   // drain the base batch
			const next = rnd();
			if (Array.isArray(t.state) && Array.isArray(next)) {
				(t.state as unknown[]).splice(0, (t.state as unknown[]).length, ...next);
			} else if (!Array.isArray(t.state) && typeof next === "object" && next !== null && !Array.isArray(next)) {
				const s = t.state as Record<string, unknown>;
				for (const k of Object.keys(s)) if (!(k in next)) delete s[k];
				for (const [k, v] of Object.entries(next)) s[k] = v;
			} else continue;
			expect(apply(structuredClone(base), t.flush())).toEqual(t.target);
			checked++;
		}
		// Most random pairs are shape-incompatible and skipped; this only guards
		// against the loop silently checking nothing.
		expect(checked).toBeGreaterThan(200);
	});
});
