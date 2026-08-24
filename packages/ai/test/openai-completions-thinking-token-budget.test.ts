import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Model, SimpleStreamOptions, ThinkingBudgets } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

type CapturedParams = {
	thinking_token_budget?: number;
	thinking_budget?: number;
	thinking_budget_tokens?: number;
	thinking?: unknown;
	chat_template_kwargs?: Record<string, unknown>;
};

function vllmModel(
	compat: Model<"openai-completions">["compat"] = {
		thinkingFormat: "zai",
		supportsThinkingTokenBudget: true,
	},
): Model<"openai-completions"> {
	return {
		id: "zai-org/glm-5.2",
		name: "GLM 5.2 (local vLLM)",
		api: "openai-completions",
		provider: "local-vllm",
		baseUrl: "http://localhost:8000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 16384,
		compat,
	};
}

async function capture(
	model: Model<"openai-completions">,
	options?: {
		reasoning?: SimpleStreamOptions["reasoning"];
		thinkingBudgets?: ThinkingBudgets;
		maxTokens?: number;
	},
): Promise<CapturedParams> {
	let payload: unknown;

	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
			reasoning: options?.reasoning,
			thinkingBudgets: options?.thinkingBudgets,
			maxTokens: options?.maxTokens,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();

	return (payload ?? mockState.lastParams) as CapturedParams;
}

describe("openai-completions thinking token budget", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends the configured budget for the requested level", async () => {
		const params = await capture(vllmModel(), { reasoning: "medium", thinkingBudgets: { medium: 4096 } });
		expect(params.thinking_token_budget).toBe(4096);
	});

	it("omits the budget when neither the field nor the alias is set", async () => {
		const params = await capture(vllmModel({ thinkingFormat: "zai" }), {
			reasoning: "medium",
			thinkingBudgets: { medium: 4096 },
		});
		expect(params.thinking_token_budget).toBeUndefined();
		expect(params.thinking_budget).toBeUndefined();
		expect(params.thinking_budget_tokens).toBeUndefined();
	});

	it("omits the budget when thinking is off", async () => {
		const params = await capture(vllmModel(), { reasoning: undefined, thinkingBudgets: { high: 8192 } });
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("clamps xhigh and max to the high budget", async () => {
		const xhigh = await capture(vllmModel(), { reasoning: "xhigh", thinkingBudgets: { high: 8192 } });
		const max = await capture(vllmModel(), { reasoning: "max", thinkingBudgets: { high: 8192 } });
		expect(xhigh.thinking_token_budget).toBe(8192);
		expect(max.thinking_token_budget).toBe(8192);
	});

	it("leaves room for the answer when the budget meets the response ceiling", async () => {
		const params = await capture(vllmModel(), { reasoning: "high" });
		expect(params.thinking_token_budget).toBe(16384 - 1024);
	});

	it("uses the caller max_tokens as the ceiling when it is lower than the model cap", async () => {
		const params = await capture(vllmModel(), {
			reasoning: "high",
			thinkingBudgets: { high: 8192 },
			maxTokens: 4096,
		});
		expect(params.thinking_token_budget).toBe(4096 - 1024);
	});

	it.each(["thinking_budget", "thinking_budget_tokens"] as const)(
		"sends %s when thinkingTokenBudgetField is set",
		async (field) => {
			const params = await capture(vllmModel({ thinkingFormat: "qwen", thinkingTokenBudgetField: field }), {
				reasoning: "medium",
				thinkingBudgets: { medium: 4096 },
			});
			expect(params[field]).toBe(4096);
			expect(params.thinking_token_budget).toBeUndefined();
		},
	);

	it("lets thinkingTokenBudgetField win over the boolean alias", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "zai",
				supportsThinkingTokenBudget: true,
				thinkingTokenBudgetField: "thinking_budget",
			}),
			{ reasoning: "medium", thinkingBudgets: { medium: 4096 } },
		);
		expect(params.thinking_budget).toBe(4096);
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("puts the clamped budget in chat_template_kwargs when $var is thinking.budget", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
					thinking_budget: { $var: "thinking.budget" },
				},
			}),
			{ reasoning: "high" },
		);
		expect(params.chat_template_kwargs).toEqual({
			enable_thinking: true,
			thinking_budget: 16384 - 1024,
		});
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("omits thinking.budget from chat_template_kwargs when thinking is off", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
					thinking_budget: { $var: "thinking.budget" },
				},
			}),
			{ reasoning: undefined },
		);
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});
