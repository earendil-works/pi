import { afterEach, expect, it, vi } from "vitest";
import { CodemodeSandboxBase } from "../src/portable.ts";

afterEach(() => vi.useRealTimers());

it("suspends a host deadline and resumes its remaining budget without reviving a timed-out run", async () => {
	vi.useFakeTimers();
	const sandbox = new CodemodeSandboxBase({}, () => ({ post: () => {}, stop: async () => {} }));
	const run = sandbox.start("", { startedAt: 0, seed: 1, timeoutMs: 100, onCall: () => {} });
	await vi.advanceTimersByTimeAsync(20);
	run.setDeadline(undefined);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(run.finished).toBe(false);
	const deadline = Date.now() + 80;
	run.setDeadline(deadline);
	await vi.advanceTimersByTimeAsync(40);
	run.setDeadline(deadline);
	await vi.advanceTimersByTimeAsync(39);
	expect(run.finished).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(await run.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
	run.setDeadline(undefined);
	expect(run.finished).toBe(true);
	await sandbox.close();
});
