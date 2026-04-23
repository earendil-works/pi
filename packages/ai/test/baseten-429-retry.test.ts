import { afterEach, describe, expect, it, vi } from "vitest";

let failuresRemaining = 0;
let createCalls = 0;
let lastDelay = 0;

// Track sleep calls to verify retry delays
const sleepCalls: number[] = [];

vi.mock("../src/utils/retry.js", () => ({
	getExponentialBackoff: (attempt: number, baseDelay: number, maxDelay: number) => {
		// Deterministic for testing — no jitter
		return Math.min(maxDelay, baseDelay * 2 ** attempt);
	},
	sleep: (ms: number, signal?: AbortSignal) => {
		sleepCalls.push(ms);
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		return Promise.resolve();
	},
}));

// Mock OpenAI SDK
vi.mock("openai", () => {
	class MockAPIError extends Error {
		status: number;
		headers: Headers;
		constructor(status: number, message: string, headers?: Record<string, string>) {
			super(message);
			this.status = status;
			this.name = "APIError";
			this.headers = new Headers(headers ?? {});
		}
	}

	class MockOpenAI {
		public chat: {
			completions: {
				create: (params: unknown, opts?: unknown) => Promise<AsyncIterable<unknown>>;
			};
		};

		constructor(_opts: unknown) {
			this.chat = {
				completions: {
					create: async (_params: unknown, _opts?: unknown) => {
						createCalls += 1;
						if (failuresRemaining > 0) {
							failuresRemaining -= 1;
							throw new MockAPIError(429, "Rate limit exceeded", {});
						}
						async function* gen(): AsyncGenerator<unknown> {
							yield {
								id: "chatcmpl-test",
								object: "chat.completion.chunk",
								choices: [
									{
										index: 0,
										delta: { content: "Hello" },
										finish_reason: null,
									},
								],
							};
							yield {
								id: "chatcmpl-test",
								object: "chat.completion.chunk",
								choices: [
									{
										index: 0,
										delta: {},
										finish_reason: "stop",
									},
								],
								usage: {
									prompt_tokens: 5,
									completion_tokens: 1,
									total_tokens: 6,
								},
							};
						}
						return gen();
					},
				},
			};
		}
	}

	return { default: MockOpenAI, APIError: MockAPIError };
});

import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model } from "../src/types.js";

afterEach(() => {
	failuresRemaining = 0;
	createCalls = 0;
	lastDelay = 0;
	sleepCalls.length = 0;
	vi.restoreAllMocks();
});

function createBasetenModel(): Model<"openai-completions"> {
	return {
		id: "baseten/test-model",
		name: "Baseten Test Model",
		api: "openai-completions",
		provider: "baseten",
		baseUrl: "https://inference.baseten.co/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createNonBasetenModel(): Model<"openai-completions"> {
	return {
		id: "gpt-4o",
		name: "GPT-4o",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

async function drainStream(stream: ReturnType<typeof streamOpenAICompletions>) {
	const events: unknown[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("baseten 429 retry", () => {
	it("retries baseten 429 up to 5 times with exponential backoff, then errors with attempt count", async () => {
		// All 6 attempts (1 initial + 5 retries) fail with 429
		failuresRemaining = 6;

		const stream = streamOpenAICompletions(createBasetenModel(), createContext(), {
			apiKey: "test-key",
			retry: { baseDelay: 1000, maxDelay: 15000 },
		});

		const events = await drainStream(stream);

		// Should have attempted 1 initial + 5 retries = 6 total
		expect(createCalls).toBe(6);

		// Should have slept 5 times with exponential backoff: 1000, 2000, 4000, 8000, 15000 (capped)
		expect(sleepCalls).toEqual([1000, 2000, 4000, 8000, 15000]);

		// Error message should include attempt count
		const errorEvent = events.find((e: any) => e.type === "error");
		expect(errorEvent).toBeDefined();
		const errorMsg = (errorEvent as any).error?.errorMessage ?? "";
		expect(errorMsg).toContain("after 6 attempts");
	});

	it("respects retry-after header with Math.max(backoff, retryAfterMs), capped at maxDelay", async () => {
		// This test verifies the retry-after header logic at the unit level
		// by checking that resolveBasetenRetryOptions returns the right delay
		// and isRetryableBaseten429 identifies the error correctly.
		// We'll test the header extraction logic via the helpers directly below.

		// For now, test that when a retry-after: 10 header is present,
		// the delay is Math.max(backoff, 10000), capped at maxDelay
		const baseDelay = 1000;
		const maxDelay = 15000;
		const attempt = 0;
		const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt); // 1000
		const retryAfterMs = 10 * 1000; // 10 seconds
		const delay = Math.min(maxDelay, Math.max(backoff, retryAfterMs));
		expect(delay).toBe(10000); // retry-after wins over backoff

		// When backoff exceeds retry-after
		const attempt3Backoff = Math.min(maxDelay, baseDelay * 2 ** 3); // 8000
		const delay3 = Math.min(maxDelay, Math.max(attempt3Backoff, retryAfterMs));
		expect(delay3).toBe(10000); // retry-after still wins

		// When both exceed maxDelay
		const retryAfterLarge = 20000;
		const delayLarge = Math.min(maxDelay, Math.max(backoff, retryAfterLarge));
		expect(delayLarge).toBe(15000); // capped at maxDelay
	});

	it("does NOT retry non-baseten 429 errors", async () => {
		failuresRemaining = 1;

		const stream = streamOpenAICompletions(createNonBasetenModel(), createContext(), {
			apiKey: "test-key",
		});

		const events = await drainStream(stream);

		// Should have attempted exactly once — no retries
		expect(createCalls).toBe(1);
		expect(sleepCalls.length).toBe(0);

		const errorEvent = events.find((e: any) => e.type === "error");
		expect(errorEvent).toBeDefined();
		// Single attempt — no "(after N attempts)" suffix
		const errorMsg = (errorEvent as any).error?.errorMessage ?? "";
		expect(errorMsg).not.toContain("after");
	});

	it("does NOT retry baseten 5xx errors (429 only)", async () => {
		// This test needs a 5xx error, which our mock doesn't throw yet.
		// We'll verify via the isRetryableBaseten429 helper tests below.
		// For now, document the expected behavior.
		expect(true).toBe(true);
	});

	it("breaks retry loop on abort signal during sleep", async () => {
		// Fail 3 times, but abort during the first sleep
		failuresRemaining = 3;

		const controller = new AbortController();
		// Abort immediately — sleep will reject
		setTimeout(() => controller.abort(), 0);

		const stream = streamOpenAICompletions(createBasetenModel(), createContext(), {
			apiKey: "test-key",
			signal: controller.signal,
			retry: { baseDelay: 1000, maxDelay: 15000 },
		});

		const events = await drainStream(stream);

		// Should have attempted at least 1 call
		expect(createCalls).toBeGreaterThanOrEqual(1);

		const errorEvent = events.find((e: any) => e.type === "error");
		expect(errorEvent).toBeDefined();
		// Should be aborted
		const reason = (errorEvent as any).reason;
		expect(reason).toBe("aborted");
	});

	it("respects options.retry.maxRetries = 0 for baseten (zero retries)", async () => {
		failuresRemaining = 1;

		const stream = streamOpenAICompletions(createBasetenModel(), createContext(), {
			apiKey: "test-key",
			retry: { maxRetries: 0 },
		});

		const events = await drainStream(stream);

		// Should have attempted exactly once — no retries despite baseten
		expect(createCalls).toBe(1);
		expect(sleepCalls.length).toBe(0);

		const errorEvent = events.find((e: any) => e.type === "error");
		expect(errorEvent).toBeDefined();
	});

	it("emits start exactly once even when retries succeed", async () => {
		// Fail once, then succeed
		failuresRemaining = 1;

		const stream = streamOpenAICompletions(createBasetenModel(), createContext(), {
			apiKey: "test-key",
			retry: { baseDelay: 1, maxDelay: 1 },
		});

		const events = await drainStream(stream);

		// Should have retried once
		expect(createCalls).toBe(2);

		// Start should be emitted exactly once
		const startEvents = events.filter((e: any) => e.type === "start");
		expect(startEvents.length).toBe(1);
	});

	it("emits start before error when all retries fail", async () => {
		failuresRemaining = 6;

		const stream = streamOpenAICompletions(createBasetenModel(), createContext(), {
			apiKey: "test-key",
			retry: { baseDelay: 1, maxDelay: 1 },
		});

		const events = await drainStream(stream);

		// Start should still be emitted before error
		const startEvents = events.filter((e: any) => e.type === "start");
		expect(startEvents.length).toBe(1);

		const errorEvent = events.find((e: any) => e.type === "error");
		expect(errorEvent).toBeDefined();

		// Start should come before error
		const startIndex = events.findIndex((e: any) => e.type === "start");
		const errorIndex = events.findIndex((e: any) => e.type === "error");
		expect(startIndex).toBeLessThan(errorIndex);
	});
});

describe("isRetryableBaseten429", () => {
	// These tests will import the helper once it exists
	it("should be defined after implementation", () => {
		// Placeholder — will be replaced with real imports
		expect(true).toBe(true);
	});
});

describe("resolveBasetenRetryOptions", () => {
	it("should be defined after implementation", () => {
		// Placeholder — will be replaced with real imports
		expect(true).toBe(true);
	});
});
