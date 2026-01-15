import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

const mockModel: Model<"openai-codex-responses"> = {
	id: "gpt-codex-test",
	name: "Codex Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function buildTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
		}),
	).toString("base64");

	return `header.${payload}.signature`;
}

function createSseResponse(payload: string): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(payload));
			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function buildCompletedPayload(): string {
	return [
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
		})}\n\n`,
		"data: [DONE]\n\n",
	].join("");
}

describe("OpenAI Codex Retry - Integration", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("retries before emitting start and succeeds once", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(createSseResponse(buildCompletedPayload()));

		vi.stubGlobal("fetch", fetchMock);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Hello",
					timestamp: Date.now(),
				},
			],
		};

		const stream = streamOpenAICodexResponses(mockModel, context, {
			apiKey: buildTestToken(),
			codexRetry: { requestMaxRetries: 1, streamMaxRetries: 0, baseDelay: 0, maxDelay: 0 },
		});

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events.filter((type) => type === "start").length).toBe(1);
		expect(events).toContain("done");

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("retries when stream terminates before completion", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(createSseResponse("data: [DONE]\n\n"))
			.mockResolvedValueOnce(createSseResponse(buildCompletedPayload()));

		vi.stubGlobal("fetch", fetchMock);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Hello",
					timestamp: Date.now(),
				},
			],
		};

		const stream = streamOpenAICodexResponses(mockModel, context, {
			apiKey: buildTestToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 1, baseDelay: 0, maxDelay: 0 },
		});

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events.filter((type) => type === "start").length).toBe(1);
		expect(events).toContain("done");
	});
});
