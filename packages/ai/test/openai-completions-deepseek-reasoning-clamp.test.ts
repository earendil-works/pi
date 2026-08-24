import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Model, SimpleStreamOptions, ThinkingLevel } from "../src/types.ts";

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
	reasoning_effort?: unknown;
	thinking?: unknown;
	thinking_token_budget?: number;
};

// Mirrors packages/ai/src/providers/data/deepseek.json deepseek-v4-flash compat:
// deepseek thinkingFormat, no numeric thinking budget field, thinkingLevelMap that
// maps max -> "max" (so an unclamped max/xhigh would otherwise reach the wire).
// thinkingLevelMap sits at the model top level (see Model.thinkingLevelMap), mirroring
// deepseek-v4-flash: deepseek thinkingFormat, no numeric thinking budget field, and a
// map that sends max -> "max" (so an unclamped max/xhigh would otherwise reach the wire).
function deepseekModel(): Model<"openai-completions"> {
	return {
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		compat: { thinkingFormat: "deepseek" },
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
	};
}
// Mirrors the openrouter deepseek-v4-flash-0731 runtime path: same model shape as
// deepseekModel (which resolves through the mock harness) but compat.thinkingFormat
// "openrouter", which routes into the openrouter reasoning branch. Its map sends
// xhigh -> "xhigh" (self) and leaves max unmapped, so an unclamped request would
// reach the wire unbounded.
function openrouterModel(): Model<"openai-completions"> {
	return {
		...(deepseekModel() as Model<"openai-completions">),
		compat: { thinkingFormat: "openrouter" },
	};
}

function capture(
	reasoningModel: Model<"openai-completions"> = deepseekModel(),
	options?: {
		reasoning?: SimpleStreamOptions["reasoning"];
	},
): Promise<CapturedParams> {
	let payload: unknown;

	return (async () => {
		await streamSimple(
			reasoningModel,
			{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
			{
				apiKey: "test",
				reasoning: options?.reasoning,
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();
		return (payload ?? mockState.lastParams) as CapturedParams;
	})();
}

describe("openai-completions deepseek reasoning clamp", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("clamps an xhigh reasoning request to the mapped high level", async () => {
		const params = await capture(deepseekModel(), { reasoning: "xhigh" as ThinkingLevel });
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("high");
	});

	it("clamps a max reasoning request to the mapped high level", async () => {
		const params = await capture(deepseekModel(), { reasoning: "max" as ThinkingLevel });
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("high");
	});

	it("keeps an explicit high request at high", async () => {
		const params = await capture(deepseekModel(), { reasoning: "high" as ThinkingLevel });
		expect(params.reasoning_effort).toBe("high");
	});

	it("sends no numeric thinking budget field for deepseek", async () => {
		const params = await capture(deepseekModel(), { reasoning: "high" as ThinkingLevel });
		expect(params.thinking_token_budget).toBeUndefined();
	});

	// Openrouter is the provider the deepseek flash model actually runs under, and its
	// entry maps xhigh -> "xhigh" (self) and leaves max unmapped. Both must be clamped.
	describe("openrouter branch", () => {
		type OpenRouterParams = CapturedParams & { reasoning?: { effort?: unknown } };

		it("clamps an xhigh request to the mapped high level", async () => {
			const params = (await capture(openrouterModel(), { reasoning: "xhigh" as ThinkingLevel })) as OpenRouterParams;
			expect(params.reasoning?.effort).toBe("high");
		});

		it("clamps a max request to the mapped high level", async () => {
			const params = (await capture(openrouterModel(), { reasoning: "max" as ThinkingLevel })) as OpenRouterParams;
			expect(params.reasoning?.effort).toBe("high");
		});

		it("keeps a high request at high", async () => {
			const params = (await capture(openrouterModel(), { reasoning: "high" as ThinkingLevel })) as OpenRouterParams;
			expect(params.reasoning?.effort).toBe("high");
		});
	});
});
