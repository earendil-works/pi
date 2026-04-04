import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { planPromptCachePolicy } from "../src/prompt-cache-policy.js";
import type { Context, Model } from "../src/types.js";

function createAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function createCodexModel(): Model<"openai-codex-responses"> {
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
		systemPrompt: "You are helpful.",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [
			{
				name: "zeta_tool",
				description: "z desc",
				parameters: Type.Object({ value: Type.String() }),
			},
			{
				name: "alpha_tool",
				description: "a desc",
				parameters: Type.Object({ value: Type.String() }),
			},
		],
	};
}

describe("planPromptCachePolicy", () => {
	it("sorts tools deterministically for Anthropic request shaping", () => {
		const plan = planPromptCachePolicy({ model: createAnthropicModel(), context: createContext() });

		expect(plan.context.tools?.map((tool) => tool.name)).toEqual(["alpha_tool", "zeta_tool"]);
		expect(plan.provider.cacheKey).toBeUndefined();
	});

	it("surfaces provider cache key for Codex-compatible prompt caching", () => {
		const plan = planPromptCachePolicy({
			model: createCodexModel(),
			context: createContext(),
			sessionId: "thread_123",
		});

		expect(plan.context.tools?.map((tool) => tool.name)).toEqual(["alpha_tool", "zeta_tool"]);
		expect(plan.provider.cacheKey).toBe("thread_123");
	});

	it("does not mutate the caller's tool order while producing a sorted plan", () => {
		const context = createContext();
		const originalOrder = context.tools?.map((tool) => tool.name);

		const plan = planPromptCachePolicy({ model: createAnthropicModel(), context });

		expect(originalOrder).toEqual(["zeta_tool", "alpha_tool"]);
		expect(context.tools?.map((tool) => tool.name)).toEqual(["zeta_tool", "alpha_tool"]);
		expect(plan.context.tools?.map((tool) => tool.name)).toEqual(["alpha_tool", "zeta_tool"]);
	});
});
