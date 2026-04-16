import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Context } from "../src/types.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string };
	output_config?: { effort?: string };
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the user's instructions exactly.",
		messages: [
			{
				role: "user",
				content:
					"Compute 48291 * 7317 and 90844 - 17729, add the results, and determine whether the sum is divisible by 11. Reply with exactly this format and nothing else: sum=<sum>; divisibleBy11=<yes|no>",
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Opus 4.7 smoke", () => {
	it("streams Claude Opus 4.7 with reasoning enabled", { retry: 2, timeout: 30000 }, async () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		let capturedPayload: AnthropicThinkingPayload | undefined;
		const s = streamSimple(model, makeContext(), {
			reasoning: "high",
			maxTokens: 1024,
			onPayload: (payload) => {
				capturedPayload = payload as AnthropicThinkingPayload;
				return payload;
			},
		});

		let sawThinking = false;

		for await (const event of s) {
			if (event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end") {
				sawThinking = true;
			}
		}

		const response = await s.result();
		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(response.errorMessage).toBeFalsy();
		expect(capturedPayload?.thinking).toEqual({ type: "adaptive" });
		expect(capturedPayload?.output_config).toEqual({ effort: "high" });
		expect(sawThinking).toBe(true);

		const thinkingBlock = response.content.find((block) => block.type === "thinking");
		expect(thinkingBlock?.type).toBe("thinking");
		if (!thinkingBlock || thinkingBlock.type !== "thinking") {
			throw new Error("Expected thinking block from Claude Opus 4.7");
		}
		expect(typeof thinkingBlock.thinkingSignature).toBe("string");
		const thinkingSignature = thinkingBlock.thinkingSignature;
		if (!thinkingSignature) {
			throw new Error("Expected thinking signature from Claude Opus 4.7");
		}
		expect(thinkingSignature.length).toBeGreaterThan(0);

		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		expect(text).toBe("sum=353418362; divisibleBy11=yes");
	});
});
