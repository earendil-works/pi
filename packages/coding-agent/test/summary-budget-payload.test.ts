import { type Model, normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { completeSummarization } from "../src/core/compaction/index.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Summarize this.", timestamp: 1 }] });
const model: Model<"openai-completions"> = {
	id: "configured-local-model",
	name: "Configured local model",
	api: "openai-completions",
	provider: "llama.cpp",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: true,
	thinkingBudgetMode: "shared",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 16384,
	compat: {
		supportsReasoningEffort: false,
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		thinkingFormat: "chat-template",
		chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
	},
};

async function capture(target: Model<"openai-completions" | "anthropic-messages">): Promise<unknown> {
	let captured: unknown;
	const response = await completeSummarization(target, context, {
		apiKey: "test-key",
		reasoning: "medium",
		maxTokens: 1024,
		onPayload: (payload) => {
			captured = payload;
			// Stop after adapter serialization, before any network request.
			throw new Error("payload captured");
		},
	});
	expect(response.errorMessage).toContain("payload captured");
	expect(captured).toBeDefined();
	return captured;
}

describe("summary budgeting through real adapters", () => {
	it("disables configured llama.cpp template thinking without growing the answer budget", async () => {
		expect(await capture(model)).toMatchObject({
			max_tokens: 1024,
			chat_template_kwargs: { enable_thinking: false },
		});
	});

	it("uses configured minimum effort and extra room when thinking cannot be disabled", async () => {
		expect(
			await capture({
				...model,
				thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" },
				compat: {
					...model.compat,
					chatTemplateKwargs: {
						enable_thinking: { $var: "thinking.enabled" },
						reasoning_effort: { $var: "thinking.effort" },
					},
				},
			}),
		).toMatchObject({
			max_tokens: 3072,
			chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" },
		});
	});

	it.each([undefined, "adapter"] as const)("leaves Anthropic allocation to its adapter with mode %s", async (mode) => {
		const anthropic: Model<"anthropic-messages"> = {
			...model,
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			compat: {},
			thinkingBudgetMode: mode,
		};
		expect(await capture(anthropic)).toMatchObject({
			max_tokens: 9216,
			thinking: { type: "enabled", budget_tokens: 8192 },
		});
	});

	it.each([undefined, "adapter"] as const)("preserves configured thinking when mode is %s", async (mode) => {
		expect(await capture({ ...model, thinkingBudgetMode: mode })).toMatchObject({
			max_tokens: 1024,
			chat_template_kwargs: { enable_thinking: true },
		});
	});
});
