import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { completeSimple } from "../src/stream.js";

function createLongSystemPrompt(): string {
	const nonce = `${Date.now()}-${Math.random()}`;
	return `You are a concise assistant.\nCache nonce: ${nonce}\n\n${Array(80)
		.fill(
			"Prompt-caching probe content. Keep this exact text stable across requests so the provider can reuse prefix tokens and report cache read and cache write usage.",
		)
		.join("\n\n")}`;
}

describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter cache_write repro E2E", () => {
	it(
		"regression: preserves cache_write_tokens on openai-completions stream path",
		{ retry: 2, timeout: 90000 },
		async () => {
			const model = getModel("openrouter", "google/gemini-2.5-flash");
			const context = {
				systemPrompt: createLongSystemPrompt(),
				messages: [
					{
						role: "user" as const,
						content: "Reply with exactly: OK",
						timestamp: Date.now(),
					},
				],
			};

			const options = {
				apiKey: process.env.OPENROUTER_API_KEY!,
				maxTokens: 32,
				temperature: 0,
				onPayload: (payload: unknown) => {
					const params = payload as {
						messages?: Array<{
							role?: string;
							content?: string | Array<{ type?: string; text?: string; cache_control?: { type: string } }>;
						}>;
					};
					const messages = params.messages;
					if (!Array.isArray(messages)) return payload;

					for (let i = messages.length - 1; i >= 0; i--) {
						const msg = messages[i];
						if (msg.role !== "user") continue;
						if (typeof msg.content === "string") {
							msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
							break;
						}
						if (!Array.isArray(msg.content)) continue;
						for (let j = msg.content.length - 1; j >= 0; j--) {
							const part = msg.content[j];
							if (part.type === "text") {
								part.cache_control = { type: "ephemeral" };
								break;
							}
						}
						break;
					}
					return payload;
				},
			};

			const first = await completeSimple(model, context, options);
			expect(first.stopReason, first.errorMessage).toBe("stop");

			const second = await completeSimple(model, context, options);
			expect(second.stopReason, second.errorMessage).toBe("stop");

			// Regression expectation: cache_write_tokens from provider usage must be preserved.
			// With the cache_control marker above, at least one of the two calls should create cache.
			const hasCacheWrite = first.usage.cacheWrite > 0 || second.usage.cacheWrite > 0;
			expect(hasCacheWrite).toBe(true);
		},
	);
});
