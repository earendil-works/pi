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

describe("max thinking level", () => {
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
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});

	it.each(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const)(
		"exposes xhigh and max for openai-codex/%s",
		(modelId) => {
			const model = getModel("openai-codex", modelId);
			expect(model).toBeDefined();
			expect(model?.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
			expect(getSupportedThinkingLevels(model!)).toEqual([
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		},
	);

	it("supports a hole between high and max", () => {
		const model: Model<"openai-completions"> = {
			id: "high-and-max",
			name: "High and Max",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: "max" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
		expect(clampThinkingLevel(model, "xhigh")).toBe("max");
	});

	it("sends max to the Codex Responses API", async () => {
		const model = getModel("openai-codex", "gpt-5.6-sol")!;
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};
		let payload: unknown;

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			reasoning: "max",
			onPayload: (request) => {
				payload = request;
				throw new Error("payload captured");
			},
		}).result();

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});
});
