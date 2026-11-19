import { afterEach, describe, expect, it, vi } from "vitest";
import { flushStdout } from "../src/utils/flush-stdout.ts";

// #12133: process.exit() dropped queued terminal mode resets; exits now wait for stdout first.
describe("flushStdout", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("resolves once stdout has written the output queued before it", async () => {
		const callbacks: Array<() => void> = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: string, callback: () => void) => {
			callbacks.push(callback);
			return false;
		}) as typeof process.stdout.write);
		let resolved = false;
		const flushed = flushStdout().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		callbacks[0]!();
		await flushed;
		expect(resolved).toBe(true);
	});

	it("resolves after the timeout when stdout never finishes writing", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockImplementation((() => false) as typeof process.stdout.write);
		let resolved = false;
		const flushed = flushStdout().then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await flushed;
		expect(resolved).toBe(true);
	});
});
