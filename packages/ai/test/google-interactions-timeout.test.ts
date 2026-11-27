import { describe, expect, it } from "vitest";
import { stream } from "../src/api/google-interactions.ts";
import { GOOGLE_AI_PLAN_MODELS } from "../src/providers/google-ai-plan.models.ts";
import type { FetchFunction } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = GOOGLE_AI_PLAN_MODELS["gemini-4-hydrogen"];
const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
const encoder = new TextEncoder();

function frame(data: object): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("google-interactions request timeout", () => {
	it("covers only the wait for the response headers, not a long stream", async () => {
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(frame({ event_type: "step.start", index: 0, step: { type: "model_output" } }));
				await sleep(100);
				controller.enqueue(frame({ event_type: "step.delta", index: 0, delta: { type: "text", text: "Hello" } }));
				controller.enqueue(frame({ event_type: "step.stop", index: 0 }));
				controller.enqueue(frame({ event_type: "interaction.completed", interaction: { status: "completed" } }));
				controller.close();
			},
		});
		const fetch: FetchFunction = async () => new Response(body, { status: 200 });

		const message = await stream(model, context, {
			headers: { Authorization: "Bearer token" },
			fetch,
			timeoutMs: 20,
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("fails when the response headers do not arrive in time", async () => {
		const fetch: FetchFunction = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});

		const message = await stream(model, context, {
			headers: { Authorization: "Bearer token" },
			fetch,
			timeoutMs: 20,
			maxRetries: 0,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Google response headers timed out after 20ms");
	});
});
