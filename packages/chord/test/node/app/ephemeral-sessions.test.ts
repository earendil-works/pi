// Tests of ephemeral sessions (slice 13 §3, carry-over to slice 11): at most `max`, the oldest ending past it; each
// ends once its last link closed and none opened for the grace period, or when none opened within it of the login.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EphemeralSessions } from "../../../src/node/app/ephemeral-sessions.ts";

const PRINCIPAL = { kind: "user", id: "u", name: "u" };

afterEach(() => {
	vi.useRealTimers();
});

describe("ephemeral sessions", () => {
	it("end with their last link after the grace period; a link opening meanwhile keeps them", () => {
		vi.useFakeTimers();
		const sessions = new EphemeralSessions(10, 1000);
		sessions.issue("a", "hash", PRINCIPAL);
		const first = sessions.linkOpened("a")!;
		const second = sessions.linkOpened("a")!;
		first();
		vi.advanceTimersByTime(5000);
		expect(sessions.get("a")).toBeDefined();
		second();
		second();
		vi.advanceTimersByTime(999);
		const again = sessions.linkOpened("a")!;
		vi.advanceTimersByTime(5000);
		expect(sessions.get("a")).toBeDefined();
		again();
		vi.advanceTimersByTime(1000);
		expect(sessions.get("a")).toBeUndefined();
		expect(sessions.linkOpened("a")).toBeUndefined();
	});

	it("end when no link opens within the grace period of the login", () => {
		vi.useFakeTimers();
		const sessions = new EphemeralSessions(10, 1000);
		sessions.issue("a", "hash", PRINCIPAL);
		vi.advanceTimersByTime(1000);
		expect(sessions.get("a")).toBeUndefined();
	});

	it("keep at most max: past it the oldest ends", () => {
		const sessions = new EphemeralSessions(2, 60_000);
		for (const id of ["a", "b", "c"]) sessions.issue(id, "hash", PRINCIPAL);
		expect(["a", "b", "c"].map((id) => sessions.get(id) !== undefined)).toEqual([false, true, true]);
		expect(sessions.revoke("b")).toBe(true);
		expect(sessions.revoke("b")).toBe(false);
		sessions.revoke("c");
	});
});
