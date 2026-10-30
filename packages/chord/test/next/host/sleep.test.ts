// Tests of the waiting helpers (§14): `sleep` resolving, rejecting with the abort reason, chaining delays above the
// timer limit and leaving no timer behind; `untilAborted`.

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withCancel } from "../../../src/context/index.ts";
import { sleep, untilAborted } from "../../../src/next/host/index.ts";
import { fakeTimers } from "../support.ts";

describe("sleep", () => {
	fakeTimers();

	it("resolves after its delay", async () => {
		let done = false;
		void sleep(1_000, BACKGROUND_CONTEXT).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects with the abort reason and clears its timer", async () => {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		const waiting = sleep(60_000, context);
		const reason = new Error("stop");
		cancel(reason);
		await expect(waiting).rejects.toBe(reason);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects at once when its context is aborted already", async () => {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		cancel(new Error("before"));
		await expect(sleep(10, context)).rejects.toThrow("before");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("chains timers for delays above 2^31-1 ms; an abort clears the chained timer", async () => {
		const limit = 2 ** 31 - 1;
		let done = false;
		void sleep(limit + 5_000, BACKGROUND_CONTEXT).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(limit);
		expect(done).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(done).toBe(true);
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		const long = sleep(3 * limit, context);
		await vi.advanceTimersByTimeAsync(limit + 1);
		cancel(new Error("late"));
		await expect(long).rejects.toThrow("late");
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("untilAborted", () => {
	it("resolves once its context is aborted, at once when it is already", async () => {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		let done = false;
		const waiting = untilAborted(context).then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		cancel();
		await waiting;
		expect(done).toBe(true);
		await untilAborted(context);
	});
});
