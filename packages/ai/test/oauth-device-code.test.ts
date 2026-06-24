import { afterEach, describe, expect, it, vi } from "vitest";
import { pollOAuthDeviceCodeFlow } from "../src/utils/oauth/device-code.ts";

describe("OAuth device-code polling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls immediately and returns the completed value", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const poll = vi.fn(async () => {
			pollTimes.push(Date.now());
			return pollTimes.length === 1
				? { status: "pending" as const }
				: { status: "complete" as const, value: "token" };
		});

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			poll,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:00Z").getTime()]);

		await vi.advanceTimersByTimeAsync(1999);
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:00Z").getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([
			new Date("2026-03-09T00:00:00Z").getTime(),
			new Date("2026-03-09T00:00:02Z").getTime(),
		]);
	});

	it("cancels an in-flight wait", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 5,
			expiresInSeconds: 30,
			poll: async () => ({ status: "pending" }),
			signal: controller.signal,
		});

		controller.abort();
		await expect(resultPromise).rejects.toThrow("Login cancelled");
	});
});
