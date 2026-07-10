import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

describe("ultra thinking level", () => {
	it("is opt-in for ordinary reasoning models", () => {
		const model: Model<"openai-completions"> = {
			id: "ordinary-reasoning",
			name: "Ordinary Reasoning",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(model, "ultra")).toBe("high");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra"] as const)("exposes ultra for openai-codex/%s", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(model?.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max", ultra: "max" });
		expect(getSupportedThinkingLevels(model!)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		]);
	});

	it("does not expose ultra for openai-codex/gpt-5.6-luna", () => {
		const model = getModel("openai-codex", "gpt-5.6-luna")!;
		expect(model.thinkingLevelMap?.ultra).toBeUndefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(clampThinkingLevel(model, "ultra")).toBe("max");
	});

	it("sends max to the Codex Responses API when ultra is selected", async () => {
		const model = getModel("openai-codex", "gpt-5.6-sol")!;
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};
		let payload: unknown;

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			reasoning: "ultra",
			onPayload: (request) => {
				payload = request;
				throw new Error("payload captured");
			},
		}).result();

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});
});
