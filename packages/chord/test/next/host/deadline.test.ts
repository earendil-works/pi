// Tests of an activation's deadline (slice 6a §9): it expires once after its budget; paused time does not count; a
// cleared deadline never expires.

import { describe, expect, it, vi } from "vitest";
import { Deadline } from "../../../src/next/host/deadline.ts";
import { fakeTimers } from "../support.ts";

describe("deadline", () => {
	fakeTimers();

	it("expires once after its budget", () => {
		const expired = vi.fn();
		new Deadline(100, expired);
		vi.advanceTimersByTime(99);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1_000);
		expect(expired).toHaveBeenCalledTimes(1);
	});

	it("paused time does not count: resumed with the budget it had left", () => {
		const expired = vi.fn();
		const deadline = new Deadline(100, expired);
		vi.advanceTimersByTime(60);
		deadline.pause();
		vi.advanceTimersByTime(1_000);
		deadline.resume();
		vi.advanceTimersByTime(39);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(expired).toHaveBeenCalledTimes(1);
	});

	it("a cleared deadline never expires, also when resumed", () => {
		const expired = vi.fn();
		const deadline = new Deadline(100, expired);
		deadline.pause();
		deadline.clear();
		deadline.resume();
		vi.advanceTimersByTime(1_000);
		expect(expired).not.toHaveBeenCalled();
	});
});
