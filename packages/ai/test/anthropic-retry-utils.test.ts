/**
 * Unit tests for retry utility functions used by Anthropic provider
 */

import { describe, expect, it } from "vitest";
import { getExponentialBackoff, sleep } from "../src/utils/retry.js";

describe("Retry Utilities", () => {
	describe("getExponentialBackoff", () => {
		it("should increase delay exponentially with each attempt", () => {
			const baseDelay = 1000;
			const maxDelay = 60000;

			const delay0 = getExponentialBackoff(0, baseDelay, maxDelay);
			const delay1 = getExponentialBackoff(1, baseDelay, maxDelay);
			const delay2 = getExponentialBackoff(2, baseDelay, maxDelay);

			// Allow 20% jitter, but verify growth pattern
			expect(delay1).toBeGreaterThan(delay0 * 0.8);
			expect(delay2).toBeGreaterThan(delay1 * 0.8);
		});

		it("should cap delay at maxDelay", () => {
			const baseDelay = 1000;
			const maxDelay = 5000;

			// Attempt 10 would normally exceed maxDelay
			const delay = getExponentialBackoff(10, baseDelay, maxDelay);

			// Allow 20% jitter over maxDelay
			expect(delay).toBeLessThanOrEqual(maxDelay * 1.2);
		});

		it("should produce values around expected base * 2^attempt", () => {
			const baseDelay = 1000;
			const maxDelay = 60000;

			// Attempt 2: expected ~4000ms (1000 * 2^2)
			const delay2 = getExponentialBackoff(2, baseDelay, maxDelay);

			// Verify within jitter range (±20%)
			expect(delay2).toBeGreaterThan(3200);
			expect(delay2).toBeLessThan(4800);
		});

		it("should include jitter (produce varying results)", () => {
			const baseDelay = 1000;
			const maxDelay = 60000;

			const delays = Array.from({ length: 10 }, () => getExponentialBackoff(1, baseDelay, maxDelay));

			const uniqueDelays = new Set(delays);
			expect(uniqueDelays.size).toBeGreaterThan(1);
		});
	});

	describe("sleep", () => {
		it("should complete after specified delay", async () => {
			const start = Date.now();
			await sleep(50);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeGreaterThanOrEqual(45);
			expect(elapsed).toBeLessThan(150);
		});

		it("should abort when signal is triggered", async () => {
			const controller = new AbortController();
			const sleepPromise = sleep(10000, controller.signal);

			controller.abort();

			await expect(sleepPromise).rejects.toThrow("Aborted");
		});

		it("should abort mid-sleep", async () => {
			const controller = new AbortController();
			const sleepPromise = sleep(1000, controller.signal);

			setTimeout(() => controller.abort(), 50);

			const start = Date.now();
			await expect(sleepPromise).rejects.toThrow("Aborted");
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(200);
		});

		it("should handle zero delay", async () => {
			await expect(sleep(0)).resolves.toBeUndefined();
		});

		it("should handle negative delay", async () => {
			await expect(sleep(-100)).resolves.toBeUndefined();
		});

		it("should work without abort signal", async () => {
			await expect(sleep(10)).resolves.toBeUndefined();
		});
	});
});
