import { afterEach, describe, expect, it, vi } from "vitest";
import { pollOAuthDeviceCodeFlow } from "../src/auth/oauth/device-code.ts";

const neverAbortedSignal = new AbortController().signal;

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
			signal: neverAbortedSignal,
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

	it("can wait before the first poll", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			waitBeforeFirstPoll: true,
			poll: async () => {
				pollTimes.push(Date.now());
				return { status: "complete" as const, value: "token" };
			},
			signal: neverAbortedSignal,
		});

		await vi.advanceTimersByTimeAsync(1999);
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:02Z").getTime()]);
	});

	it("increases the interval by 5 seconds after slow_down without a server interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));
		const startTime = Date.now();

		const pollTimes: number[] = [];
		const results = [{ status: "slow_down" as const }, { status: "complete" as const, value: "token" }];
		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 900,
			poll: async () => {
				pollTimes.push(Date.now());
				const result = results.shift();
				if (!result) throw new Error("Unexpected extra poll");
				return result;
			},
			signal: neverAbortedSignal,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toEqual([startTime]);

		await vi.advanceTimersByTimeAsync(7249);
		expect(pollTimes).toEqual([startTime]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([startTime, startTime + 7250]);
	});

	it("honors a server-provided slow_down interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));
		const startTime = Date.now();

		const pollTimes: number[] = [];
		const results = [
			{ status: "slow_down" as const, intervalSeconds: 30 },
			{ status: "complete" as const, value: "token" },
		];
		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 900,
			poll: async () => {
				pollTimes.push(Date.now());
				const result = results.shift();
				if (!result) throw new Error("Unexpected extra poll");
				return result;
			},
			signal: neverAbortedSignal,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toEqual([startTime]);

		await vi.advanceTimersByTimeAsync(30249);
		expect(pollTimes).toEqual([startTime]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([startTime, startTime + 30250]);
	});

	it.each([true, false])(
		"doubles the extra margin up to 5 seconds, retaining it after pending (server interval: %s)",
		async (serverInterval) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const pollTimes: number[] = [];
			const statuses = [
				"slow_down",
				"slow_down",
				"pending",
				"slow_down",
				"slow_down",
				"slow_down",
				"slow_down",
				"slow_down",
			] as const;
			const resultPromise = pollOAuthDeviceCodeFlow({
				intervalSeconds: 5,
				expiresInSeconds: 900,
				signal: neverAbortedSignal,
				poll: async () => {
					const status = statuses[pollTimes.length];
					pollTimes.push(Date.now());
					if (!status) return { status: "complete", value: "token" };
					return { status, intervalSeconds: serverInterval ? 10 : undefined };
				},
			});
			await vi.runAllTimersAsync();
			await expect(resultPromise).resolves.toBe("token");
			const delays = pollTimes.slice(1).map((time, index) => time - pollTimes[index]);
			expect(delays).toEqual(
				serverInterval
					? [10250, 10500, 10500, 11000, 12000, 14000, 15000, 15000]
					: [10250, 15500, 15500, 21000, 27000, 34000, 40000, 45000],
			);
		},
	);

	// https://github.com/microsoft/WSL/issues/12583: local clocks can run at the wrong rate.
	it("recovers when both timers and Date.now run 10% faster than the authorization server", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let serverIntervalMs = 5000;
		let lastServerPollTime = 0;
		let slowDownResponses = 0;
		let acceptedPolls = 0;
		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 5,
			expiresInSeconds: 900,
			waitBeforeFirstPoll: true,
			signal: neverAbortedSignal,
			poll: async () => {
				const serverTime = Date.now() / 1.1;
				const elapsed = serverTime - lastServerPollTime;
				lastServerPollTime = serverTime;
				if (elapsed < serverIntervalMs) {
					serverIntervalMs += 5000;
					slowDownResponses++;
					return { status: "slow_down", intervalSeconds: serverIntervalMs / 1000 };
				}
				acceptedPolls++;
				return acceptedPolls === 1 ? { status: "pending" } : { status: "complete", value: "token" };
			},
		});
		// Handle rejection immediately so the unpatched timeout is an assertion failure, not an unhandled rejection.
		const outcome = resultPromise.catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		expect(await outcome).toBe("token");
		expect(slowDownResponses).toBe(5);
		expect(acceptedPolls).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not lower the existing interval when slow_down reports a smaller one", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const poll = vi
			.fn()
			.mockResolvedValueOnce({ status: "slow_down", intervalSeconds: 5 })
			.mockResolvedValueOnce({ status: "complete", value: "token" });
		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 30,
			expiresInSeconds: 60,
			signal: neverAbortedSignal,
			poll,
		});
		await vi.advanceTimersByTimeAsync(30249);
		expect(poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it("does not carry a learned margin into a new login", async () => {
		vi.useFakeTimers();
		const firstPoll = vi
			.fn()
			.mockResolvedValueOnce({ status: "slow_down", intervalSeconds: 5 })
			.mockResolvedValueOnce({ status: "complete", value: "first-token" });
		const first = pollOAuthDeviceCodeFlow({ poll: firstPoll, signal: neverAbortedSignal });
		await vi.runAllTimersAsync();
		await expect(first).resolves.toBe("first-token");

		const secondPoll = vi.fn().mockResolvedValue({ status: "complete", value: "second-token" });
		const second = pollOAuthDeviceCodeFlow({
			waitBeforeFirstPoll: true,
			poll: secondPoll,
			signal: neverAbortedSignal,
		});
		await vi.advanceTimersByTimeAsync(4999);
		expect(secondPoll).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(second).resolves.toBe("second-token");
	});

	it("cancels during the extra margin without another poll or a leftover timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const poll = vi.fn().mockResolvedValue({ status: "slow_down", intervalSeconds: 5 });
		const resultPromise = pollOAuthDeviceCodeFlow({ poll, signal: controller.signal });
		const rejection = expect(resultPromise).rejects.toThrow("Login cancelled");
		await vi.advanceTimersByTimeAsync(5000);
		controller.abort();
		await rejection;
		expect(poll).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clamps the margin to the device-code deadline without a post-expiry poll", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const poll = vi.fn().mockResolvedValue({ status: "slow_down", intervalSeconds: 5 });
		const resultPromise = pollOAuthDeviceCodeFlow({
			expiresInSeconds: 5.1,
			poll,
			signal: neverAbortedSignal,
		});
		const rejection = expect(resultPromise).rejects.toThrow(
			"Device flow timed out after one or more slow_down responses",
		);
		await vi.advanceTimersByTimeAsync(5099);
		expect(poll).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		expect(poll).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
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
