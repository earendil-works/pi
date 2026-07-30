import { describe, expect, it, vi } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
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
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
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

const TEXT_MODELS = [
	"MiniMax-M2.5",
	"deepseek-v3.2",
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"glm-5",
	"glm-5.1",
	"glm-5.2",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"qwen3.6-flash",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max-preview",
];

const IMAGE_MODELS = ["qwen-image-2.0", "qwen-image-2.0-pro", "wan2.7-image", "wan2.7-image-pro"];

const QWEN_THINKING_MODELS = [
	"deepseek-v3.2",
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"glm-5",
	"glm-5.1",
	"glm-5.2",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"qwen3.6-flash",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max-preview",
] as const;

const QWEN_THINKING_MODEL_CASES = (["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) =>
	QWEN_THINKING_MODELS.map((modelId) => ({ provider, modelId })),
);

const QWEN_REASONING_EFFORT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2"] as const;

const QWEN_REASONING_EFFORT_MODEL_CASES = (["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) =>
	QWEN_REASONING_EFFORT_MODELS.map((modelId) => ({ provider, modelId })),
);

describe("Qwen Token Plan models", () => {
	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)("exposes all text models on %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const expected of TEXT_MODELS) {
			expect(modelIds, `${provider} should include ${expected}`).toContain(expected);
		}
	});

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)("omits image models from %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const excluded of IMAGE_MODELS) {
			expect(modelIds, `${provider} should not include ${excluded}`).not.toContain(excluded);
		}
	});

	// docs: https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=api&commonbuy=1#/api/?type=model&url=3016807
	it.each(QWEN_THINKING_MODEL_CASES)(
		"sends Qwen thinking fields for $provider/$modelId",
		async ({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

			let payload: unknown;
			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: "high",
					onPayload: (params) => {
						payload = params;
					},
				},
			).result();

			expect(payload).toHaveProperty("enable_thinking", true);
			expect(payload).not.toHaveProperty("thinking");
		},
	);

	it.each(QWEN_REASONING_EFFORT_MODEL_CASES)(
		"exposes Qwen reasoning_effort levels for $provider/$modelId",
		({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

			expect(model.thinkingLevelMap).toMatchObject({
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			});
		},
	);

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)(
		"exposes qwen3.8 reasoning_effort levels on %s",
		(provider) => {
			const model = getModels(provider).find((candidate) => candidate.id === "qwen3.8-max-preview");
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/qwen3.8-max-preview`);

			expect(model.thinkingLevelMap).toMatchObject({
				minimal: null,
				low: "low",
				medium: "medium",
				high: null,
				xhigh: "xhigh",
				max: null,
			});
		},
	);

	it.each(QWEN_REASONING_EFFORT_MODEL_CASES)(
		"sends Qwen reasoning_effort for $provider/$modelId",
		async ({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

			let payload: unknown;
			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: "high",
					onPayload: (params) => {
						payload = params;
					},
				},
			).result();

			expect(payload).toHaveProperty("reasoning_effort", "high");
		},
	);

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)(
		"sends qwen3.8 max reasoning_effort on %s",
		async (provider) => {
			const model = getModels(provider).find((candidate) => candidate.id === "qwen3.8-max-preview");
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/qwen3.8-max-preview`);

			let payload: unknown;
			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: "xhigh",
					onPayload: (params) => {
						payload = params;
					},
				},
			).result();

			expect(payload).toHaveProperty("enable_thinking", true);
			expect(payload).toHaveProperty("reasoning_effort", "xhigh");
			expect(payload).not.toHaveProperty("thinking");
		},
	);
});
