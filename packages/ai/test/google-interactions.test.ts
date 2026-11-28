import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/google-interactions.ts";
import { GOOGLE_AI_PLAN_MODELS } from "../src/providers/google-ai-plan.models.ts";
import type { FetchFunction } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = GOOGLE_AI_PLAN_MODELS["gemini-4-hydrogen"];
const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
const headers = { Authorization: "Bearer token" };
const encoder = new TextEncoder();

/** One SSE frame in the shape Google sends (`event:` line plus `data:` JSON). */
function frame(data: { event_type: string } & Record<string, unknown>): string {
	return `event: ${data.event_type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: string[]): Response {
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("google-interactions stream", () => {
	// Event shapes from a recorded gemini-4-hydrogen tool turn, plus a summary and a text step.
	it("turns thought, text and function_call steps into one message", async () => {
		const frames = [
			frame({ event_type: "step.start", index: 0, step: { type: "thought" } }),
			frame({
				event_type: "step.delta",
				index: 0,
				delta: { type: "thought_summary", content: { type: "text", text: "Need the file." } },
			}),
			frame({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "c2ln" } }),
			frame({ event_type: "step.stop", index: 0 }),
			frame({ event_type: "step.start", index: 1, step: { type: "model_output" } }),
			frame({ event_type: "step.delta", index: 1, delta: { type: "text", text: "Reading it." } }),
			frame({ event_type: "step.stop", index: 1 }),
			frame({
				event_type: "step.start",
				index: 2,
				step: { type: "function_call", id: "call_1", name: "read_file", arguments: {} },
			}),
			frame({ event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '{"path":' } }),
			frame({ event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '"a.py"}' } }),
			frame({ event_type: "step.stop", index: 2 }),
			frame({
				event_type: "interaction.completed",
				interaction: {
					status: "requires_action",
					usage: {
						total_tokens: 184,
						total_input_tokens: 114,
						total_cached_tokens: 10,
						total_output_tokens: 26,
						total_thought_tokens: 44,
					},
				},
			}),
			"event: done\ndata: [DONE]\n\n",
		];
		const fetch: FetchFunction = async () => sseResponse(frames);

		const message = await stream(model, context, { headers, fetch }).result();

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "Need the file.", thinkingSignature: "c2ln" },
			{ type: "text", text: "Reading it." },
			{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.py" } },
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.usage).toMatchObject({ input: 104, cacheRead: 10, output: 70, reasoning: 44, totalTokens: 184 });
	});

	it("fails a stream that closes before interaction.completed", async () => {
		const fetch: FetchFunction = async () =>
			sseResponse([
				frame({ event_type: "step.start", index: 0, step: { type: "model_output" } }),
				frame({ event_type: "step.delta", index: 0, delta: { type: "text", text: "Partial" } }),
			]);

		const message = await stream(model, context, { headers, fetch, maxRetries: 0 }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Google stream ended before interaction.completed");
	});
});

describe("google-interactions request", () => {
	it("sends a stateless request with a supported thinking level and no sampling settings", async () => {
		let body: Record<string, unknown> = {};
		const fetch: FetchFunction = async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return new Response("", { status: 500 });
		};
		const tool = { name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };

		await streamSimple(
			model,
			normalizeContext({
				systemPrompt: "Be brief.",
				tools: [tool],
				messages: [{ role: "user", content: "Hi", timestamp: 0 }],
			}),
			// Gemini 4 rejects "minimal" with a 400; the nearest supported level is sent instead.
			{ headers, fetch, reasoning: "minimal", temperature: 0.5, maxRetries: 0 },
		).result();

		expect(body).toMatchObject({
			model: "gemini-4-hydrogen",
			store: false,
			stream: true,
			system_instruction: "Be brief.",
			tools: [{ type: "function", name: "read_file", description: "Read a file" }],
			generation_config: { thinking_level: "low", thinking_summaries: "auto" },
		});
		expect(body.generation_config).not.toHaveProperty("temperature");
	});
});

describe("google-interactions request timeout", () => {
	it("covers only the wait for the response headers, not a long stream", async () => {
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(
					encoder.encode(frame({ event_type: "step.start", index: 0, step: { type: "model_output" } })),
				);
				await sleep(100);
				controller.enqueue(
					encoder.encode(frame({ event_type: "step.delta", index: 0, delta: { type: "text", text: "Hello" } })),
				);
				controller.enqueue(encoder.encode(frame({ event_type: "step.stop", index: 0 })));
				controller.enqueue(
					encoder.encode(frame({ event_type: "interaction.completed", interaction: { status: "completed" } })),
				);
				controller.close();
			},
		});
		const fetch: FetchFunction = async () => new Response(body, { status: 200 });

		const message = await stream(model, context, { headers, fetch, timeoutMs: 20 }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("fails when the response headers do not arrive in time", async () => {
		const fetch: FetchFunction = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});

		const message = await stream(model, context, { headers, fetch, timeoutMs: 20, maxRetries: 0 }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Google response headers timed out after 20ms");
	});
});
