import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";

const originalBasetenApiKey = process.env.BASETEN_API_KEY;

afterEach(() => {
	if (originalBasetenApiKey === undefined) {
		delete process.env.BASETEN_API_KEY;
	} else {
		process.env.BASETEN_API_KEY = originalBasetenApiKey;
	}
});

describe("Baseten models", () => {
	it("registers GLM 5.2 as the default OpenAI-compatible reasoning model", () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");

		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "baseten",
			baseUrl: "https://inference.baseten.co/v1",
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 262144,
			cost: {
				input: 1.4,
				output: 4.4,
				cacheRead: 0.3,
				cacheWrite: 0,
			},
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: true,
				supportsLongCacheRetention: false,
				thinkingFormat: "baseten",
				chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		});
	});

	it("models Kimi K2.6 reasoning as an explicit off/on toggle", async () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6");
		let payload: Record<string, unknown> | undefined;

		expect(model.thinkingLevelMap).toEqual({
			off: "off",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(model.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "baseten",
			chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBeUndefined();
	});

	it("sends Baseten chat_template_args with reasoning effort", async () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBe("high");
	});

	it("disables Baseten opt-in reasoning when thinking is off", async () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: false });
		expect(payload?.reasoning_effort).toBe("none");
	});

	it("resolves BASETEN_API_KEY from the environment", () => {
		process.env.BASETEN_API_KEY = "test-baseten-key";

		expect(findEnvKeys("baseten")).toEqual(["BASETEN_API_KEY"]);
		expect(getEnvApiKey("baseten")).toBe("test-baseten-key");
	});
});
