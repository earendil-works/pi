import { describe, expect, it, vi } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";
import { findEnvKeys } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { ThinkingLevel } from "../src/types.ts";

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

const PROVIDER = "tencent-token-plan-individual";

// https://cloud.tencent.com/document/product/1823/130119
// GLM-5 and GLM-5.1 are omitted: both are reasoning toggle-only, so they offer no
// effort control over GLM-5.2.
const DOCUMENTED_MODEL_IDS = [
	"tc-code-latest",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-pro",
	"glm-5.2",
	"minimax-m2.7",
];

/** Models whose upstream catalog documents an explicit effort vocabulary. */
const EFFORT_MODELS = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "glm-5.2"] as const;

/** Auto routes to an unknown model and MiniMax-M2.7 always thinks. */
const ALWAYS_THINKING_MODELS = ["tc-code-latest", "minimax-m2.7"] as const;

function getModel(modelId: string) {
	const model = getModels(PROVIDER).find((candidate) => candidate.id === modelId);
	if (!model) throw new Error(`Missing model: ${PROVIDER}/${modelId}`);
	return model;
}

async function capturePayload(modelId: string, reasoning?: ThinkingLevel): Promise<Record<string, unknown>> {
	let payload: unknown;
	await streamSimple(
		getModel(modelId),
		{
			systemPrompt: "Be terse",
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test",
			reasoning,
			onPayload: (params) => {
				payload = params;
			},
		},
	).result();
	return payload as Record<string, unknown>;
}

describe("Tencent Token Plan Individual models", () => {
	it("exposes exactly the supported 通用 Token Plan models", () => {
		expect(
			getModels(PROVIDER)
				.map((model) => model.id)
				.sort(),
		).toEqual([...DOCUMENTED_MODEL_IDS].sort());
	});

	it("omits the toggle-only GLM-5 and GLM-5.1 superseded by GLM-5.2", () => {
		const modelIds = getModels(PROVIDER).map((model) => model.id);
		expect(modelIds).not.toContain("glm-5");
		expect(modelIds).not.toContain("glm-5-0");
		expect(modelIds).not.toContain("glm-5.1");
		expect(modelIds).not.toContain("glm-5-1");
	});

	it("omits the Kimi-K2.5 model retired on 2026-08-31", () => {
		const modelIds = getModels(PROVIDER).map((model) => model.id);
		expect(modelIds).not.toContain("kimi-k2.5");
		expect(modelIds).not.toContain("kimi-k-2-5");
	});

	it("reads its key from TENCENT_TOKEN_PLAN_API_KEY", () => {
		expect(findEnvKeys(PROVIDER, { TENCENT_TOKEN_PLAN_API_KEY: "test" })).toEqual(["TENCENT_TOKEN_PLAN_API_KEY"]);
	});

	it("targets the Individual Token Plan endpoint", () => {
		for (const modelId of DOCUMENTED_MODEL_IDS) {
			expect(getModel(modelId).baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");
		}
	});

	it.each(DOCUMENTED_MODEL_IDS)("caps output with max_tokens on %s", async (modelId) => {
		const payload = await capturePayload(modelId);
		expect(payload).toHaveProperty("max_tokens");
		expect(payload).not.toHaveProperty("max_completion_tokens");
		expect(payload).not.toHaveProperty("store");
	});

	// The endpoint rejects the OpenAI `developer` role with error 20024.
	it.each(DOCUMENTED_MODEL_IDS)("sends the system prompt as system on %s", async (modelId) => {
		const messages = (await capturePayload(modelId)).messages as Array<{ role: string }>;
		expect(messages[0]).toMatchObject({ role: "system" });
		expect(messages.some((message) => message.role === "developer")).toBe(false);
	});

	it.each(EFFORT_MODELS)("sends reasoning_effort on %s", async (modelId) => {
		const payload = await capturePayload(modelId, "high");
		expect(payload).toHaveProperty("thinking", { type: "enabled" });
		expect(payload).toHaveProperty("reasoning_effort", "high");
	});

	// No level is selectable on these models, so any requested level clamps away
	// and the reasoning parameter stays absent.
	it.each(ALWAYS_THINKING_MODELS)("omits the reasoning parameter on %s", async (modelId) => {
		const payload = await capturePayload(modelId, "high");
		expect(payload).not.toHaveProperty("reasoning_effort");
		expect(payload).not.toHaveProperty("thinking");
	});

	// Reasoning off means no `reasoning` level is requested at all.
	it.each(ALWAYS_THINKING_MODELS)("omits the thinking field on %s when no reasoning level is set", async (modelId) => {
		const payload = await capturePayload(modelId);
		expect(payload).not.toHaveProperty("thinking");
	});

	// This gateway documents the full low/high/max effort vocabulary for both V4 sizes.
	it.each(["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"] as const)(
		"offers low, high and max on %s",
		(modelId) => {
			expect(getModel(modelId).thinkingLevelMap).toMatchObject({
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				max: "max",
			});
			expect(getSupportedThinkingLevels(getModel(modelId))).toEqual(["off", "low", "high", "max"]);
		},
	);

	it("maps GLM-5.2 reasoning levels to the high and max values upstream advertises", () => {
		expect(getModel("glm-5.2").thinkingLevelMap).toMatchObject({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(getSupportedThinkingLevels(getModel("glm-5.2"))).toEqual(["high", "max"]);
	});

	it.each(ALWAYS_THINKING_MODELS)("offers no thinking level on %s", (modelId) => {
		expect(getSupportedThinkingLevels(getModel(modelId))).toEqual([]);
	});

	it("replays reasoning_content on assistant messages", () => {
		for (const modelId of DOCUMENTED_MODEL_IDS) {
			expect(getModel(modelId).compat).toMatchObject({ requiresReasoningContentOnAssistantMessages: true });
		}
	});
});
