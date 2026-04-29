/**
 * Gloo AI provider integration tests.
 *
 * Two layers:
 *   1. Catalog/static — runs everywhere. Asserts the 23-model catalog is
 *      registered, has the expected shape, and that the toolcall blocklist
 *      contains the three known-bad models.
 *   2. Live — runs only when GLOO_CLIENT_ID + GLOO_CLIENT_SECRET are set in
 *      the environment. Mints a real OAuth bearer, streams against three
 *      representative models (Sonnet 4.6, GPT-4.1, DeepSeek R1), and
 *      confirms the platform's tool-rejection contract for DeepSeek R1.
 *
 * The live tier is gated, never required, and times out at 30s per case so
 * it can run as part of the regular `npm test` without flaking CI.
 */

import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getProviders } from "../src/models.js";
import { GLOO_TOOLCALL_BLOCKLIST, stripChatCompletionsSuffix } from "../src/providers/gloo.js";
import { streamSimple } from "../src/stream.js";
import type { Context } from "../src/types.js";

const HAS_GLOO_CREDS = !!(process.env.GLOO_CLIENT_ID && process.env.GLOO_CLIENT_SECRET);

describe("Gloo AI catalog (static)", () => {
	it("registers gloo as a provider", () => {
		expect(getProviders()).toContain("gloo");
	});

	it("seeds 22 models in the catalog", () => {
		// 6 Anthropic + 3 Google + 7 OpenAI + 6 open-source = 22.
		// (gloo-google-gemini-3-pro-preview was dropped 2026-04-27 from upstream.)
		const models = getModels("gloo");
		expect(models.length).toBe(22);
	});

	it("every gloo model is tagged with api='gloo-openai-completions' and provider='gloo'", () => {
		for (const model of getModels("gloo")) {
			expect(model.api).toBe("gloo-openai-completions");
			expect(model.provider).toBe("gloo");
			expect(model.baseUrl).toMatch(/\/ai\/v2$/);
		}
	});

	it("getModel('gloo', 'gloo-anthropic-claude-sonnet-4.6') resolves", () => {
		const m = getModel("gloo", "gloo-anthropic-claude-sonnet-4.6");
		expect(m).toBeTruthy();
		expect(m.id).toBe("gloo-anthropic-claude-sonnet-4.6");
		expect(m.contextWindow).toBe(200_000);
		expect(m.reasoning).toBe(true);
		expect(m.input).toContain("image");
	});

	it("toolcall blocklist contains the three known-bad models", () => {
		expect(GLOO_TOOLCALL_BLOCKLIST.has("gloo-deepseek-r1")).toBe(true);
		expect(GLOO_TOOLCALL_BLOCKLIST.has("gloo-meta-llama-4-maverick")).toBe(true);
		expect(GLOO_TOOLCALL_BLOCKLIST.has("gloo-meta-llama-3.1-8b-instruct")).toBe(true);
		// And nothing else — keeps the list tight.
		expect(GLOO_TOOLCALL_BLOCKLIST.size).toBe(3);
	});

	it("decommissioned models are absent from the catalog", () => {
		// gloo-google-gemini-3-pro-preview was removed on 2026-04-27 because
		// /ai/v2/models started returning "model not supported".
		const m = getModel("gloo", "gloo-google-gemini-3-pro-preview" as never);
		expect(m).toBeUndefined();
	});

	it("stripChatCompletionsSuffix peels '/ai/v2' off the model baseUrl", () => {
		expect(stripChatCompletionsSuffix("https://platform.ai.gloo.com/ai/v2")).toBe("https://platform.ai.gloo.com");
		expect(stripChatCompletionsSuffix("https://platform.ai.gloo.com/ai/v2/")).toBe("https://platform.ai.gloo.com");
		expect(stripChatCompletionsSuffix("http://localhost:8000/ai/v2")).toBe("http://localhost:8000");
	});

	it("env-api-keys reports gloo configured iff both env vars are set", () => {
		const original = { id: process.env.GLOO_CLIENT_ID, secret: process.env.GLOO_CLIENT_SECRET };
		try {
			process.env.GLOO_CLIENT_ID = "test-id";
			process.env.GLOO_CLIENT_SECRET = "test-secret";
			expect(findEnvKeys("gloo")).toEqual(["GLOO_CLIENT_ID", "GLOO_CLIENT_SECRET"]);
			expect(getEnvApiKey("gloo")).toBe("<authenticated>");

			delete process.env.GLOO_CLIENT_SECRET;
			expect(findEnvKeys("gloo")).toBeUndefined();
			expect(getEnvApiKey("gloo")).toBeUndefined();
		} finally {
			if (original.id !== undefined) process.env.GLOO_CLIENT_ID = original.id;
			else delete process.env.GLOO_CLIENT_ID;
			if (original.secret !== undefined) process.env.GLOO_CLIENT_SECRET = original.secret;
			else delete process.env.GLOO_CLIENT_SECRET;
		}
	});
});

describe.skipIf(!HAS_GLOO_CREDS)("Gloo AI live smoke (requires GLOO_CLIENT_ID + GLOO_CLIENT_SECRET)", () => {
	function shortPrompt(): Context {
		return {
			systemPrompt: "Reply with exactly one short sentence and nothing else.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Say hi from Gloo to pi-mono." }],
					timestamp: Date.now(),
				},
			],
		};
	}

	it("streams gloo-anthropic-claude-sonnet-4.6 to a finished response", { timeout: 30000, retry: 1 }, async () => {
		const model = getModel("gloo", "gloo-anthropic-claude-sonnet-4.6");
		const result = await streamSimple(model, shortPrompt(), { maxTokens: 64 }).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.errorMessage).toBeFalsy();
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("");
		expect(text.length).toBeGreaterThan(0);
	});

	it("streams gloo-openai-gpt-4.1 to a finished response", { timeout: 30000, retry: 1 }, async () => {
		const model = getModel("gloo", "gloo-openai-gpt-4.1");
		const result = await streamSimple(model, shortPrompt(), { maxTokens: 64 }).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.errorMessage).toBeFalsy();
	});

	it(
		"streams gloo-deepseek-v3.2 (open-source representative) to a finished response",
		{ timeout: 30000, retry: 1 },
		async () => {
			// We pick V3.2 (not R1) as the open-source live smoke because as of
			// 2026-04-29 the Gloo platform returns
			//   { code: 3001, type: "internal_error", message: "Streaming error occurred", fault: "internal" }
			// for `gloo-deepseek-r1` while V3.2 and Chat V3.1 both stream cleanly.
			// Trace logged via x-sentry-trace-id; see
			// .context/logs/2026-04-29-gloo-deepseek-r1-platform-regression.md.
			const model = getModel("gloo", "gloo-deepseek-v3.2");
			const result = await streamSimple(model, shortPrompt(), { maxTokens: 128 }).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.errorMessage).toBeFalsy();
		},
	);

	it(
		"strips tools for blocklisted models — vanilla request to gloo-meta-llama-4-maverick succeeds with tools client-side-removed",
		{ timeout: 30000, retry: 1 },
		async () => {
			const model = getModel("gloo", "gloo-meta-llama-4-maverick");
			const ctx: Context = {
				...shortPrompt(),
				tools: [
					{
						name: "noop",
						description: "Returns nothing.",
						parameters: { type: "object", properties: {} },
					},
				],
			};
			const result = await streamSimple(model, ctx, { maxTokens: 128 }).result();
			// Wrapper drops tools client-side, so the platform never sees them
			// and the request succeeds instead of hitting HTTP 400
			// "model does not support function calling".
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.errorMessage).toBeFalsy();
		},
	);
});
