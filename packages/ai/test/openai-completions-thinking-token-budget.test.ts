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

// vLLM-served reasoning model: reasoning and the answer share max_tokens.
const vllmModel: Model<"openai-completions"> = {
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
	compat: { thinkingFormat: "zai", supportsThinkingTokenBudget: true },
};

async function capture(
	model: Model<"openai-completions">,
	options?: {
		reasoning?: SimpleStreamOptions["reasoning"];
		thinkingBudgets?: ThinkingBudgets;
		maxTokens?: number;
	},
): Promise<{ thinking_token_budget?: number; thinking?: unknown }> {
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

	return (payload ?? mockState.lastParams) as { thinking_token_budget?: number; thinking?: unknown };
}

describe("openai-completions thinking_token_budget", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends the configured budget for the requested level", async () => {
		const params = await capture(vllmModel, { reasoning: "medium", thinkingBudgets: { medium: 4096 } });
		expect(params.thinking_token_budget).toBe(4096);
	});

	it("omits the budget when the compat flag is not set", async () => {
		const model = { ...vllmModel, compat: { thinkingFormat: "zai" } } as Model<"openai-completions">;
		const params = await capture(model, { reasoning: "medium", thinkingBudgets: { medium: 4096 } });
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("omits the budget when thinking is off", async () => {
		const params = await capture(vllmModel, { reasoning: undefined, thinkingBudgets: { high: 8192 } });
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("clamps xhigh and max to the high budget", async () => {
		const xhigh = await capture(vllmModel, { reasoning: "xhigh", thinkingBudgets: { high: 8192 } });
		const max = await capture(vllmModel, { reasoning: "max", thinkingBudgets: { high: 8192 } });
		expect(xhigh.thinking_token_budget).toBe(8192);
		expect(max.thinking_token_budget).toBe(8192);
	});

	it("leaves room for the answer when the budget meets the response ceiling", async () => {
		// Default high budget (16384) equals the model ceiling, which would leave no answer.
		const params = await capture(vllmModel, { reasoning: "high" });
		expect(params.thinking_token_budget).toBe(16384 - 1024);
	});

	it("uses the caller max_tokens as the ceiling when it is lower than the model cap", async () => {
		const params = await capture(vllmModel, { reasoning: "high", thinkingBudgets: { high: 8192 }, maxTokens: 4096 });
		expect(params.thinking_token_budget).toBe(4096 - 1024);
	});
});
