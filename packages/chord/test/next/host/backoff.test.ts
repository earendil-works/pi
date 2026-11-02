import { describe, expect, it, vi } from "vitest";
import { Backoff } from "../../../src/next/host/backoff.ts";
import { fakeTimers } from "../support.ts";

/** The length of the window `failed` opens for `identity`, measured until `due` runs. */
function window(backoff: Backoff, due: ReturnType<typeof vi.fn>, identity: string): number {
	const calls = due.mock.calls.length;
	const start = Date.now();
	backoff.failed(identity);
	while (due.mock.calls.length === calls) vi.advanceTimersByTime(100);
	return Date.now() - start;
}

describe("backoff", () => {
	fakeTimers();

	it("opens a window of 1 s after the first failure, doubling up to 60 s, and calls due at its end", () => {
		const due = vi.fn();
		const backoff = new Backoff(due);
		const windows = Array.from({ length: 9 }, () => window(backoff, due, "a"));
		expect(windows).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
		expect(due.mock.calls.every(([identity]) => identity === "a")).toBe(true);
	});

	it("tells when a running window ends: a failed reference's retryAt", () => {
		const backoff = new Backoff(() => {});
		vi.advanceTimersByTime(5_000);
		backoff.failed("a");
		expect([backoff.until("a"), backoff.until("b")]).toEqual([6_000, undefined]);
		vi.advanceTimersByTime(1_000);
		expect(backoff.until("a")).toBeUndefined();
		backoff.failed("a");
		expect(backoff.until("a")).toBe(8_000);
		backoff.skip("a");
		expect(backoff.until("a")).toBeUndefined();
	});

	it("is waiting only inside a window", () => {
		const backoff = new Backoff(() => {});
		backoff.failed("a");
		expect([backoff.waiting("a"), backoff.waiting("b")]).toEqual([true, false]);
		vi.advanceTimersByTime(1000);
		expect(backoff.waiting("a")).toBe(false);
	});

	it("skip ends a window without due and keeps its delay; delete starts over", () => {
		const due = vi.fn();
		const backoff = new Backoff(due);
		backoff.failed("a");
		backoff.skip("a");
		vi.advanceTimersByTime(5000);
		expect([backoff.waiting("a"), due.mock.calls.length]).toEqual([false, 0]);
		expect(window(backoff, due, "a")).toBe(2000);
		backoff.delete("a");
		expect(window(backoff, due, "a")).toBe(1000);
	});

	it("ended keeps a running window and drops a passed one", () => {
		const due = vi.fn();
		const backoff = new Backoff(due);
		backoff.failed("a");
		backoff.ended("a");
		expect(backoff.waiting("a")).toBe(true);
		vi.advanceTimersByTime(1000);
		backoff.ended("a");
		expect(window(backoff, due, "a")).toBe(1000);
	});

	it("a failure inside a running window replaces it: one due, after the doubled delay", () => {
		const due = vi.fn();
		const backoff = new Backoff(due);
		backoff.failed("a");
		backoff.failed("a");
		vi.advanceTimersByTime(1999);
		expect([due.mock.calls.length, vi.getTimerCount()]).toEqual([0, 1]);
		vi.advanceTimersByTime(1);
		expect(due).toHaveBeenCalledTimes(1);
	});

	it("clear forgets every identity with its timer", () => {
		const backoff = new Backoff(() => {});
		backoff.failed("a");
		backoff.failed("b");
		backoff.clear();
		expect([backoff.waiting("a"), backoff.waiting("b"), vi.getTimerCount()]).toEqual([false, false, 0]);
	});
});
