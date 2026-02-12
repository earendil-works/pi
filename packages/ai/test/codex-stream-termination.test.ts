// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const originalFetch = global.fetch;

interface StreamRunResult {
	events: string[];
	resultStopReason: string;
	resultError?: string;
	resultText?: string;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function createCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseResponse(sse: string): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function runCodexStreamWithSse(sse: string): Promise<StreamRunResult> {
	global.fetch = vi.fn(async () => createSseResponse(sse)) as typeof fetch;

	const stream = streamOpenAICodexResponses(createModel(), createContext(), {
		apiKey: createCodexToken(),
		codexRetry: {
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		},
	});

	const events: string[] = [];
	for await (const event of stream) {
		if (event.type === "done") {
			events.push(`done:${event.reason}`);
		} else if (event.type === "error") {
			events.push(`error:${event.reason}`);
		} else {
			events.push(event.type);
		}
	}

	const result = await stream.result();
	const textBlock = result.content.find((block) => block.type === "text");
	return {
		events,
		resultStopReason: result.stopReason,
		resultError: result.errorMessage,
		resultText: textBlock?.type === "text" ? textBlock.text : undefined,
	};
}

describe("openai-codex stream termination handling", () => {
	it("parses CRLF-delimited SSE frames correctly", async () => {
		const events =
			[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\r\n\r\n") + "\r\n\r\n";

		const run = await runCodexStreamWithSse(events);
		expect(run.events).toContain("text_delta");
		expect(run.events).toContain("done:stop");
		expect(run.resultStopReason).toBe("stop");
		expect(run.resultText).toBe("Hello");
	});

	it("fails when stream ends with non-terminal completion status", async () => {
		const sse = `data: ${JSON.stringify({ type: "response.done", response: { status: "in_progress" } })}\n\n`;
		const run = await runCodexStreamWithSse(sse);

		expect(run.events).toContain("error:error");
		expect(run.events.some((event) => event.startsWith("done:"))).toBe(false);
		expect(run.resultStopReason).toBe("error");
		expect(run.resultError).toContain("non-terminal status: in_progress");
	});

	it("emits error event instead of done when completion status is failed", async () => {
		const sse = `data: ${JSON.stringify({ type: "response.done", response: { status: "failed" } })}\n\n`;
		const run = await runCodexStreamWithSse(sse);

		expect(run.events).toContain("error:error");
		expect(run.events.some((event) => event.startsWith("done:"))).toBe(false);
		expect(run.resultStopReason).toBe("error");
		expect(run.resultError).toContain("Codex response failed");
	});
});
