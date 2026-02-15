// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

let nextStreamEvents: unknown[] = [];
let failuresRemaining = 0;
let createCalls = 0;

class StatusError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = "StatusError";
	}
}

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (_params: unknown) => {
					createCalls += 1;
					if (failuresRemaining > 0) {
						failuresRemaining -= 1;
						throw new StatusError(502, "exceeded request buffer limit while retrying upstream");
					}
					async function* gen(): AsyncGenerator<unknown> {
						for (const ev of nextStreamEvents) yield ev;
					}
					return gen();
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.js";

afterEach(() => {
	nextStreamEvents = [];
	failuresRemaining = 0;
	createCalls = 0;
	vi.restoreAllMocks();
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
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

describe("openai-responses retry", () => {
	it("retries request failures before streaming begins (no duplicate start)", async () => {
		failuresRemaining = 2;
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), {
			apiKey: "test-key",
			retry: { maxRetries: 2, baseDelay: 0, maxDelay: 0 },
		});

		const eventTypes: string[] = [];
		for await (const ev of stream) {
			if (ev.type === "done") eventTypes.push(`done:${ev.reason}`);
			else if (ev.type === "error") eventTypes.push(`error:${ev.reason}`);
			else eventTypes.push(ev.type);
		}

		const result = await stream.result();

		expect(createCalls).toBe(3);
		expect(eventTypes.filter((t) => t === "start").length).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});
});
