import { describe, expect, it } from "vitest";
import { clampMaxTokensToContext } from "../src/api/simple-options.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const WINDOW = 1_048_576;

function modelWith(maxTokens: number, contextWindow = WINDOW): Model<"openai-completions"> {
	const { compat: _compat, ...base } = getModel("openai", "gpt-4o-mini")!;
	return { ...base, api: "openai-completions", contextWindow, maxTokens };
}

// The last assistant usage anchors the estimate, so the estimated input is exactly `inputTokens`.
function contextWithInput(inputTokens: number) {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: inputTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
	return normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }, assistant] });
}

describe("clampMaxTokensToContext", () => {
	it("leaves 15% of the input unused so an OpenRouter overcount still fits (#10497)", () => {
		// The failing request from #10497: OpenRouter counted 229,747 input tokens where pi estimated 220,815.
		const maxTokens = clampMaxTokensToContext(modelWith(943_718), contextWithInput(220_815), 943_718);
		expect(maxTokens).toBe(WINDOW - 220_815 - 33_123);
		expect(229_747 + maxTokens).toBeLessThanOrEqual(WINDOW);
	});

	it("leaves at least 4096 tokens unused for small inputs", () => {
		expect(clampMaxTokensToContext(modelWith(WINDOW), contextWithInput(10_000), WINDOW)).toBe(WINDOW - 10_000 - 4096);
	});

	it("keeps the model output limit when it already fits", () => {
		expect(clampMaxTokensToContext(modelWith(64_000), contextWithInput(100_000), 64_000)).toBe(64_000);
	});

	it("sends up to 32768 tokens when the proportional margin leaves no room", () => {
		expect(clampMaxTokensToContext(modelWith(943_718), contextWithInput(912_000), 943_718)).toBe(32_768);
	});

	it("uses the real room minus 4096 when less than 32768 tokens fit", () => {
		expect(clampMaxTokensToContext(modelWith(943_718), contextWithInput(1_030_000), 943_718)).toBe(
			WINDOW - 1_030_000 - 4096,
		);
	});

	it("keeps only the fixed 4096 margin for small windows", () => {
		expect(clampMaxTokensToContext(modelWith(32_768, 32_768), contextWithInput(20_000), 32_768)).toBe(
			32_768 - 20_000 - 4096,
		);
	});

	it("sends 1 token when the input already exceeds the window", () => {
		expect(clampMaxTokensToContext(modelWith(943_718), contextWithInput(1_050_000), 943_718)).toBe(1);
	});
});
