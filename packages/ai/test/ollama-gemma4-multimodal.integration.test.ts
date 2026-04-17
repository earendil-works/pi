/**
 * Integration test: route video/audio content parts through the openai-completions
 * provider to a locally-running Ollama instance serving Gemma 4. Skipped unless
 * OLLAMA_INTEGRATION=1 is set so it never fires in CI.
 *
 * Prereq: `ollama pull gemma4` and `ollama serve` on localhost:11434.
 */
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { Context, Model, OpenAICompletionsCompat } from "../src/types.js";

const RUN = process.env.OLLAMA_INTEGRATION === "1";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const GEMMA_MODEL = process.env.OLLAMA_GEMMA_MODEL ?? "gemma4:26b";

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	reasoningEffortMap: {},
	supportsUsageInStreaming: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	supportsStrictMode: false,
};

// 1x1 red PNG (smallest valid PNG)
const RED_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

function buildModel(input: ("text" | "image" | "video" | "audio")[]): Model<"openai-completions"> {
	const base = getModel("openai", "gpt-4o-mini");
	return { ...base, api: "openai-completions", input };
}

describe.skipIf(!RUN)("Ollama Gemma 4 multimodal integration", () => {
	it("builds a video_url content part that Ollama accepts without schema error", async () => {
		const model = buildModel(["text", "video"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "one word response please: ok" },
						// Small fake mp4 payload — Gemma 4 may reject the content, but we
						// only assert the request shape is forwarded through without the
						// gateway returning a schema-validation 4xx on the content part.
						{ type: "image", data: "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=", mimeType: "video/mp4" },
					],
					timestamp: Date.now(),
				},
			],
		};

		const params = convertMessages(model, context, compat);

		const res = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: GEMMA_MODEL, messages: params, max_tokens: 16 }),
		});

		const text = await res.text();
		// Ollama returns 200 OK with a response body even if the model can't consume the
		// media payload; what we're ruling out is a 400 "unknown content part type".
		expect(res.status, `ollama response: ${text}`).toBeLessThan(500);
		if (res.status === 400) {
			expect(text.toLowerCase()).not.toContain("unknown content");
			expect(text.toLowerCase()).not.toContain("invalid type");
		}
	}, 60_000);

	it("image_url still works end-to-end (regression guard)", async () => {
		const model = buildModel(["text", "image"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What color is this? answer with one word" },
						{ type: "image", data: RED_PIXEL_PNG, mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		};

		const params = convertMessages(model, context, compat);

		const res = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: GEMMA_MODEL, messages: params, max_tokens: 64 }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		// Gemma 4 via Ollama may emit output in either `content` or `reasoning` depending
		// on how the server routes thinking blocks. Accept either — what we're asserting
		// is that the image_url content part was consumed and produced a response.
		const msg = body?.choices?.[0]?.message;
		const reply = (msg?.content ?? "") + (msg?.reasoning ?? "");
		expect(reply.length).toBeGreaterThan(0);
	}, 180_000);
});
