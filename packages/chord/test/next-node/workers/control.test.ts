// Tests of the control channel's crossings (slice 10 §3): errors cross as `{ message, code?, reason? }` and back, a
// reload report with its errors and parked causes.

import { describe, expect, it } from "vitest";
import { ChordError, isChordError } from "../../../src/next/data/index.ts";
import {
	controlOf,
	crossed,
	crossedReport,
	envelope,
	uncrossed,
	uncrossedReport,
} from "../../../src/next-node/workers/control.ts";

describe("errors", () => {
	it("cross as message, code and reason, never a stack or cause; come back as ChordErrors when they had a code", () => {
		const chord = new ChordError({ code: "unavailable", message: "gone" }, { cause: new Error("inner") });
		expect(crossed(chord)).toEqual({ message: "gone", code: "unavailable" });
		expect(crossed(new Error("plain"))).toEqual({ message: "plain" });
		expect(crossed("text")).toEqual({ message: "text" });
		const back = uncrossed({ message: "gone", code: "released", reason: "closed" });
		expect(isChordError(back, "released") && back.reason).toBe("closed");
		expect(uncrossed({ message: "odd", code: "no-such-code" })).toMatchObject({ message: "odd" });
	});

	it("crosses a report's failures and parked causes and back", () => {
		const report = crossedReport({
			plugins: { added: ["@a/x"], changed: [], removed: [] },
			failed: [{ plugin: "@a/y", error: new Error("broken") }],
			objects: [
				{ object: "a.one", kind: "swapped" },
				{
					object: "a.two",
					kind: "parked",
					cause: { kind: "waiting", error: new ChordError({ code: "unavailable", message: "w" }) },
				},
			],
		});
		expect(JSON.parse(JSON.stringify(report))).toEqual(report);
		const back = uncrossedReport(report);
		expect(back.failed[0]!.error).toBeInstanceOf(Error);
		expect(back.objects[1]).toMatchObject({
			kind: "parked",
			cause: { kind: "waiting", error: { code: "unavailable" } },
		});
	});
});

describe("envelopes", () => {
	it("tells control messages from anything else on the channel", () => {
		expect(controlOf(envelope({ kind: "started" }))).toEqual({ kind: "started" });
		expect(controlOf(new Uint8Array(1))).toBeUndefined();
		expect(controlOf({ kind: "started" })).toBeUndefined();
	});
});
