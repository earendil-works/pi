import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
	/** When true, the fake provider streams its chunks and then goes silent forever. */
	stallAtEnd: false,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunkSets.shift() ?? [];
					const stallAtEnd = mockState.stallAtEnd;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
							if (stallAtEnd) {
								// Simulates a provider that accepts the request, streams part
								// of the answer, then goes silent without erroring.
								await new Promise<never>(() => {});
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function model(): Model<"openai-completions"> {
	return {
		id: "z-ai/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-idle",
		model: "z-ai/glm-5.3-flash",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

async function collectEvents(streamIdleTimeoutMs?: number): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const eventStream = streamOpenAICompletions(
		model(),
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
		{ apiKey: "test", ...(streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs }) },
	);
	for await (const event of eventStream) events.push(event);
	return events;
}

describe("openai-completions stream idle guard", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
		mockState.stallAtEnd = false;
	});

	it("aborts a silent stream with a retryable timeout error", async () => {
		mockState.chunkSets = [[chunk({ content: "partial answer" })]];
		mockState.stallAtEnd = true;

		const events = await collectEvents(50);
		const terminal = events.at(-1);

		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("Expected terminal error event");
		expect(terminal.error.stopReason).toBe("error");
		expect(terminal.error.errorMessage).toContain("timed out");
		// The wait must be recoverable by the auto-retry policy, not a dead end.
		expect(isRetryableAssistantError(terminal.error)).toBe(true);
		// Content streamed before the stall is preserved for the caller.
		expect(JSON.stringify(terminal.error.content)).toContain("partial answer");
	});

	it("leaves a stream that keeps producing chunks alone", async () => {
		mockState.chunkSets = [[chunk({ content: "full " }), chunk({ content: "answer" }, "stop")]];

		const events = await collectEvents(50);
		const terminal = events.at(-1);

		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(terminal?.type).toBe("done");
		if (terminal?.type !== "done") throw new Error("Expected terminal done event");
		expect(terminal.message.stopReason).toBe("stop");
	});
});
