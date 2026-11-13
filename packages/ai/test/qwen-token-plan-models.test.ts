import { describe, expect, it, vi } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { qwenTokenPlanProvider } from "../src/providers/qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "../src/providers/qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "../src/providers/qwen-token-plan-individual.ts";
import { qwenTokenPlanIndividualCnProvider } from "../src/providers/qwen-token-plan-individual-cn.ts";

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

const QWEN_PROVIDERS = {
	"qwen-token-plan": qwenTokenPlanProvider,
	"qwen-token-plan-cn": qwenTokenPlanCnProvider,
	"qwen-token-plan-individual": qwenTokenPlanIndividualProvider,
	"qwen-token-plan-individual-cn": qwenTokenPlanIndividualCnProvider,
};

const TEXT_MODELS = [
	"MiniMax-M2.5",
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
	"qwen3.8-flash",
	"qwen3.8-max",
];

const INDIVIDUAL_TEXT_MODELS = [
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"deepseek-v4.1-flash",
	"deepseek-v4.1-flash-1017",
	"glm-5.2",
	"glm-5.3",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
];

const IMAGE_MODELS = ["qwen-image-2.0", "qwen-image-2.0-pro", "wan2.7-image", "wan2.7-image-pro"];

const QWEN_THINKING_MODELS = [
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
	"qwen3.8-flash",
	"qwen3.8-max",
] as const;

type QwenTokenPlanProvider =
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "qwen-token-plan-individual-cn";
type QwenTokenPlanModelCase = { provider: QwenTokenPlanProvider; modelId: string };

const QWEN_THINKING_MODEL_CASES: QwenTokenPlanModelCase[] = [
	...(["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) =>
		QWEN_THINKING_MODELS.map((modelId) => ({ provider, modelId })),
	),
	...INDIVIDUAL_TEXT_MODELS.map((modelId) => ({ provider: "qwen-token-plan-individual" as const, modelId })),
	...INDIVIDUAL_TEXT_MODELS.map((modelId) => ({ provider: "qwen-token-plan-individual-cn" as const, modelId })),
];

const QWEN_REASONING_EFFORT_MODELS = ["deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2"] as const;
const QWEN38_MODELS = ["qwen3.8-flash", "qwen3.8-max"] as const;

const QWEN_REASONING_EFFORT_MODEL_CASES: QwenTokenPlanModelCase[] = [
	...(["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) =>
		QWEN_REASONING_EFFORT_MODELS.map((modelId) => ({ provider, modelId })),
	),
	...["deepseek-v4-flash-0731", "deepseek-v4-pro", "deepseek-v4-pro-0813", "glm-5.2", "glm-5.3"].map((modelId) => ({
		provider: "qwen-token-plan-individual" as const,
		modelId,
	})),
	...["deepseek-v4-flash-0731", "deepseek-v4-pro", "deepseek-v4-pro-0813", "glm-5.2", "glm-5.3"].map((modelId) => ({
		provider: "qwen-token-plan-individual-cn" as const,
		modelId,
	})),
];

const QWEN38_MODEL_CASES: QwenTokenPlanModelCase[] = (
	["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "qwen-token-plan-individual-cn"] as const
).flatMap((provider) => QWEN38_MODELS.map((modelId) => ({ provider, modelId })));

describe("Qwen Token Plan models", () => {
	// #9021
	it("exposes exactly the documented Individual text models", () => {
		const modelIds = getModels("qwen-token-plan-individual")
			.map((model) => model.id)
			.sort();

		expect(modelIds).toEqual([...INDIVIDUAL_TEXT_MODELS].sort());
	});

	it("exposes exactly the documented Individual text models on the China endpoint", () => {
		const modelIds = getModels("qwen-token-plan-individual-cn")
			.map((model) => model.id)
			.sort();

		expect(modelIds).toEqual([...INDIVIDUAL_TEXT_MODELS].sort());
	});

	// #11773
	it.each([
		["qwen-token-plan", "QWEN_TOKEN_PLAN_TEAM_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"],
		["qwen-token-plan-cn", "QWEN_TOKEN_PLAN_TEAM_CN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"],
		["qwen-token-plan-individual", "QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"],
		["qwen-token-plan-individual-cn", "QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"],
	] as const)(
		"prefers the per-plan key on %s and falls back to the shared one",
		async (provider, planVar, sharedVar) => {
			const resolve = async (env: Record<string, string>) => {
				const models = createModels({
					authContext: { env: async (name) => env[name], fileExists: async () => false },
				});
				models.setProvider(QWEN_PROVIDERS[provider]());
				return (await models.getAuth(provider))?.auth.apiKey;
			};

			expect(await resolve({ [planVar]: "plan", [sharedVar]: "shared" })).toBe("plan");
			expect(await resolve({ [sharedVar]: "shared" })).toBe("shared");
			expect(getEnvApiKey(provider, { [planVar]: "plan", [sharedVar]: "shared" })).toBe("plan");
			expect(getEnvApiKey(provider, { [sharedVar]: "shared" })).toBe("shared");
		},
	);

	it("keeps a per-plan key away from the other plan", () => {
		expect(findEnvKeys("qwen-token-plan", { QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY: "test" })).toBeUndefined();
		expect(findEnvKeys("qwen-token-plan-individual-cn", { QWEN_TOKEN_PLAN_TEAM_CN_API_KEY: "test" })).toBeUndefined();
	});

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
				low: modelId === "glm-5.3" ? "low" : null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			});
		},
	);

	it("exposes glm-5.3 reasoning_effort levels for qwen-token-plan-individual", () => {
		const model = getModels("qwen-token-plan-individual").find((candidate) => candidate.id === "glm-5.3");
		expect(model).toBeDefined();
		if (!model) throw new Error("Missing model: qwen-token-plan-individual/glm-5.3");

		expect(model.thinkingLevelMap).toMatchObject({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it.each(QWEN38_MODEL_CASES)(
		"exposes qwen3.8 reasoning_effort levels for $provider/$modelId",
		({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

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

	it.each([
		"qwen-token-plan",
		"qwen-token-plan-cn",
		"qwen-token-plan-individual",
		"qwen-token-plan-individual-cn",
	] as const)("omits retired models on %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		// #11773: deepseek-v3.2 and deepseek-v4-flash left the Token Plan model lists.
		for (const retired of ["qwen3.8-max-preview", "deepseek-v3.2", "deepseek-v4-flash"]) {
			expect(modelIds).not.toContain(retired);
		}
	});

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

	it.each(QWEN38_MODEL_CASES)(
		"sends qwen3.8 xhigh reasoning_effort for $provider/$modelId",
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
