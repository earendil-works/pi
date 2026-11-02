import { describe, expect, it } from "vitest";
import { broken, ChordError } from "../../../src/next/data/index.ts";
import { invalid, openFailure, sameCause, waitingFor } from "../../../src/next/data/internal.ts";

describe("failure causes", () => {
	it("a value thrown by an open is transient unless marked broken", () => {
		const error = new Error("network down");
		const transient = openFailure(error, "open notes");
		expect(transient.kind).toBe("transient");
		expect(transient.error.toJSON()).toEqual({ code: "unavailable", message: "open notes: network down" });
		expect(transient.error.cause).toBe(error);
	});

	it("broken() marks an open's failure as broken; its message is the cause's", () => {
		const marked = broken(new Error("bad config"));
		expect(marked.message).toBe("bad config");
		const cause = openFailure(marked, "open notes");
		expect(cause.kind).toBe("broken");
		expect(cause.error.message).toBe("open notes: bad config");
	});

	it("the kind comes from the stage, never from the error code", () => {
		const chord = invalid("host_address", "wrong host");
		expect(openFailure(chord, "open")).toEqual({ kind: "transient", error: chord });
		expect(openFailure(broken(chord), "open")).toEqual({ kind: "broken", error: chord });
	});
});

describe("a dependent's waiting cause (dependency model §3)", () => {
	const root = new ChordError({ code: "unavailable", message: "app.catalog is not served here" });

	it("names the nearest blocker and the root cause, its blocker's error as the cause", () => {
		const cause = waitingFor("app.chat(S1)", root);
		expect(cause.kind).toBe("waiting");
		expect(cause.error.toJSON()).toEqual({
			code: "unavailable",
			message: "waiting for app.chat(S1): app.catalog is not served here",
		});
		expect(cause.error.cause).toBe(root);
		// A chain names its nearest blocker and its root only (fix round 1, Opus F1).
		const chain = waitingFor("app.panel", cause.error);
		expect(chain.error.message).toBe("waiting for app.panel: app.catalog is not served here");
	});

	it("reaches a fixed point when a ring of waiting attempts passes its causes round (Opus F1)", () => {
		let b = waitingFor("X", new ChordError({ code: "unavailable", message: "X is not served here" })).error;
		let rounds = 0;
		for (; rounds < 10; rounds++) {
			const next = waitingFor("A", waitingFor("B", b).error).error;
			if (next.message === b.message) break;
			b = next;
		}
		expect(rounds).toBeLessThanOrEqual(1);
		expect(b.message).toBe("waiting for A: X is not served here");
	});

	it("keeps the root cause within 500 characters: a long label is clipped first (Sol 8)", () => {
		const original = new ChordError({ code: "unavailable", message: "ORIGINAL: missing provider" });
		const message = waitingFor(`sol.item(${"x".repeat(600)})`, original).error.message;
		expect(message.length).toBeLessThanOrEqual(500);
		expect(message).toContain(original.message);
		expect(message.startsWith("waiting for sol.item(xxx")).toBe(true);
	});

	it("keeps a long chain's root cause, never repeated ellipses (Sol 8)", () => {
		const original = new ChordError({ code: "unavailable", message: "ORIGINAL: missing provider" });
		let error = original;
		for (let i = 0; i < 2000; i++) error = waitingFor(`level-${i}`, error).error;
		expect(error.message).toBe("waiting for level-1999: ORIGINAL: missing provider");
	});

	it("clips a long root past its share, and both when both are long", () => {
		const long = new ChordError({ code: "unavailable", message: "y".repeat(600) });
		const short = waitingFor("app.a", long).error.message;
		expect(short).toHaveLength(500);
		expect(short.startsWith("waiting for app.a: yyy")).toBe(true);
		const both = waitingFor("z".repeat(600), long).error.message;
		expect(both).toHaveLength(500);
		expect(both.endsWith("y…")).toBe(true);
	});

	it("is compared by value: kind, code, reason and message", () => {
		expect(sameCause(waitingFor("a", root), waitingFor("a", root))).toBe(true);
		expect(sameCause(waitingFor("a", root), waitingFor("b", root))).toBe(false);
		expect(sameCause({ kind: "broken", error: root }, { kind: "transient", error: root })).toBe(false);
		const other = new ChordError({ code: "unavailable", reason: "undeclared", message: root.message });
		expect(sameCause({ kind: "waiting", error: root }, { kind: "waiting", error: other })).toBe(false);
	});
});
