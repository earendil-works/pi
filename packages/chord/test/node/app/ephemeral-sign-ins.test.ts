// Tests of ephemeral sign-ins (slice 13 §3, carry-over to slice 11): at most `max`, the oldest ending past it; each
// ends once its last link closed and none opened for the grace period, or when none opened within it of the login.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EphemeralSignIns } from "../../../src/node/app/ephemeral-sign-ins.ts";

const PRINCIPAL = { kind: "user", id: "u", name: "u" };

afterEach(() => {
	vi.useRealTimers();
});

describe("ephemeral sign-ins", () => {
	it("end with their last link after the grace period; a link opening meanwhile keeps them", () => {
		vi.useFakeTimers();
		const signIns = new EphemeralSignIns(10, 1000);
		signIns.issue("a", "hash", PRINCIPAL);
		const first = signIns.linkOpened("a")!;
		const second = signIns.linkOpened("a")!;
		first();
		vi.advanceTimersByTime(5000);
		expect(signIns.get("a")).toBeDefined();
		second();
		second();
		vi.advanceTimersByTime(999);
		const again = signIns.linkOpened("a")!;
		vi.advanceTimersByTime(5000);
		expect(signIns.get("a")).toBeDefined();
		again();
		vi.advanceTimersByTime(1000);
		expect(signIns.get("a")).toBeUndefined();
		expect(signIns.linkOpened("a")).toBeUndefined();
	});

	it("end when no link opens within the grace period of the login", () => {
		vi.useFakeTimers();
		const signIns = new EphemeralSignIns(10, 1000);
		signIns.issue("a", "hash", PRINCIPAL);
		vi.advanceTimersByTime(1000);
		expect(signIns.get("a")).toBeUndefined();
	});

	it("keep at most max: past it the oldest ends", () => {
		const signIns = new EphemeralSignIns(2, 60_000);
		for (const id of ["a", "b", "c"]) signIns.issue(id, "hash", PRINCIPAL);
		expect(["a", "b", "c"].map((id) => signIns.get(id) !== undefined)).toEqual([false, true, true]);
		expect(signIns.revoke("b")).toBe(true);
		expect(signIns.revoke("b")).toBe(false);
		signIns.revoke("c");
	});
});
