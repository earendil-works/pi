// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

let nextStreamEvents: unknown[] = [];

// Mock the OpenAI SDK used by openai-responses provider.
// We only need enough surface area to return a controlled async iterable stream.
vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (_params: unknown) => {
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

async function runOpenAIResponsesStream(
	events: unknown[],
): Promise<{ eventTypes: string[]; stopReason: string; error?: string }> {
	nextStreamEvents = events;

	const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });

	const eventTypes: string[] = [];
	for await (const ev of stream) {
		if (ev.type === "done") eventTypes.push(`done:${ev.reason}`);
		else if (ev.type === "error") eventTypes.push(`error:${ev.reason}`);
		else eventTypes.push(ev.type);
	}

	const result = await stream.result();
	return { eventTypes, stopReason: result.stopReason, error: result.errorMessage };
}

describe("openai-responses stream termination handling", () => {
	it("emits error if the stream ends without response.completed", async () => {
		const run = await runOpenAIResponsesStream([
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
			// Intentionally omit response.completed
		]);

		expect(run.eventTypes).toContain("error:error");
		expect(run.eventTypes.some((t) => t.startsWith("done:"))).toBe(false);
		expect(run.stopReason).toBe("error");
		expect(run.error).toContain("Stream terminated");
	});

	it("fails when completion status is queued/in_progress (non-terminal)", async () => {
		const run = await runOpenAIResponsesStream([{ type: "response.completed", response: { status: "queued" } }]);

		expect(run.eventTypes).toContain("error:error");
		expect(run.eventTypes.some((t) => t.startsWith("done:"))).toBe(false);
		expect(run.stopReason).toBe("error");
		expect(run.error).toContain("non-terminal status: queued");
	});
});
