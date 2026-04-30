import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogleGeminiCli } from "../src/providers/google-gemini-cli.js";
import type { Context, Model, ToolCall } from "../src/types.js";

const emptySchema = Type.Object({});

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("google providers tool call missing args", () => {
	it("defaults arguments to empty object when provider omits args field", async () => {
		// Simulate a tool call response where args is missing (no-arg tool)
		const sse = `${[
			`data: ${JSON.stringify({
				response: {
					candidates: [
						{
							content: {
								role: "model",
								parts: [
									{
										functionCall: {
											name: "get_status",
											// args intentionally omitted
										},
									},
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						totalTokenCount: 15,
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const dataStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async () => {
			return new Response(dataStream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"google-gemini-cli"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const context: Context = {
			messages: [{ role: "user", content: "Check status", timestamp: Date.now() }],
			tools: [
				{
					name: "get_status",
					description: "Get current status",
					parameters: emptySchema,
				},
			],
		};

		const stream = streamGoogleGeminiCli(model, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		});

		for await (const _ of stream) {
			// consume stream
		}

		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);

		const toolCall = result.content[0] as ToolCall;
		expect(toolCall.type).toBe("toolCall");
		expect(toolCall.name).toBe("get_status");
		expect(toolCall.arguments).toEqual({});
	});
});
