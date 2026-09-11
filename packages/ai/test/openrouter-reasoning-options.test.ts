import { describe, expect, it } from "vitest";
import { getOpenRouterThinkingLevelMap } from "../scripts/openrouter-reasoning-options.ts";
import { streamSimple } from "../src/api/openai-completions.ts";
import type { Context, Model, ThinkingLevelMap } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

function openRouterModel(thinkingLevelMap?: ThinkingLevelMap): Model<"openai-completions"> {
	return {
		id: "stealth/ox-alpha",
		name: "Ox Alpha",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: { thinkingFormat: "openrouter" },
	};
}

async function capturePayload(model: Model<"openai-completions">, reasoning?: "low") {
	let payload: { reasoning?: { effort?: string } } | undefined;
	await streamSimple(model, context, {
		apiKey: "test",
		reasoning,
		onPayload: (request) => {
			payload = request as { reasoning?: { effort?: string } };
			throw new Error("payload captured");
		},
	}).result();
	if (!payload) throw new Error("OpenRouter payload was not captured");
	return payload;
}

describe("getOpenRouterThinkingLevelMap", () => {
	it("marks mandatory reasoning and unsupported efforts unavailable", () => {
		expect(
			getOpenRouterThinkingLevelMap({
				mandatory: true,
				default_enabled: true,
				supported_efforts: ["max", "high", "low"],
				default_effort: "max",
			}),
		).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("still marks off unavailable when OpenRouter omits effort metadata", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: true })).toEqual({ off: null });
	});

	it("keeps off available while restricting optional models to supported efforts", () => {
		expect(
			getOpenRouterThinkingLevelMap({
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["high", "low"],
			}),
		).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("does not add metadata for optional models without effort controls", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: false })).toBeUndefined();
	});
});

describe("OpenRouter mandatory reasoning payloads", () => {
	const mandatoryMap = getOpenRouterThinkingLevelMap({
		mandatory: true,
		supported_efforts: ["max", "high", "low"],
	});

	it("omits reasoning when a background call does not request it", async () => {
		expect(await capturePayload(openRouterModel(mandatoryMap))).not.toHaveProperty("reasoning");
	});

	it("still sends an explicitly selected supported effort", async () => {
		expect(await capturePayload(openRouterModel(mandatoryMap), "low")).toMatchObject({
			reasoning: { effort: "low" },
		});
	});

	it("continues to explicitly disable reasoning for optional models", async () => {
		expect(await capturePayload(openRouterModel())).toMatchObject({
			reasoning: { effort: "none" },
		});
	});
});
