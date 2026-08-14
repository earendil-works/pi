import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalSiliconflowApiKey = process.env.SILICONFLOW_API_KEY;

afterEach(() => {
	if (originalSiliconflowApiKey === undefined) {
		delete process.env.SILICONFLOW_API_KEY;
	} else {
		process.env.SILICONFLOW_API_KEY = originalSiliconflowApiKey;
	}
});

function capturePayload(model: Parameters<typeof streamSimple>[0], reasoning?: "high") {
	let payload: Record<string, unknown> | undefined;
	const result = streamSimple(
		model,
		{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
		{
			apiKey: "test-siliconflow-key",
			reasoning,
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				throw new Error("payload captured");
			},
		},
	).result();
	return { payload: () => payload, result };
}

describe("SiliconFlow models", () => {
	it("registers GLM 5.2 as an OpenAI-compatible reasoning model", () => {
		const model = getModel("siliconflow", "zai-org/GLM-5.2");

		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "siliconflow",
			baseUrl: "https://api.siliconflow.com/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 1049000,
			maxTokens: 262000,
			cost: {
				input: 1.4,
				output: 4.4,
				cacheRead: 0.26,
				cacheWrite: 0,
			},
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			},
		});
	});

	it("toggles reasoning with top-level enable_thinking on toggle models", async () => {
		const model = getModel("siliconflow", "Qwen/Qwen3-14B");
		expect(model.compat).toMatchObject({ thinkingFormat: "qwen", supportsReasoningEffort: false });

		const on = capturePayload(model, "high");
		await on.result;
		expect(on.payload()?.enable_thinking).toBe(true);

		const off = capturePayload(model);
		await off.result;
		expect(off.payload()?.enable_thinking).toBe(false);
		expect(off.payload()?.reasoning_effort).toBeUndefined();
	});

	it("sends no thinking params on reasoning models without a toggle", async () => {
		const model = getModel("siliconflow", "zai-org/GLM-5.2");

		const { payload, result } = capturePayload(model, "high");
		await result;
		expect(payload()?.enable_thinking).toBeUndefined();
		expect(payload()?.reasoning_effort).toBeUndefined();
	});

	it("resolves SILICONFLOW_API_KEY from the environment", () => {
		process.env.SILICONFLOW_API_KEY = "test-siliconflow-key";

		expect(findEnvKeys("siliconflow")).toEqual(["SILICONFLOW_API_KEY"]);
		expect(getEnvApiKey("siliconflow")).toBe("test-siliconflow-key");
	});
});
