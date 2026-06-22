import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalMergeGatewayApiKey = process.env.MERGE_GATEWAY_API_KEY;

afterEach(() => {
	if (originalMergeGatewayApiKey === undefined) {
		delete process.env.MERGE_GATEWAY_API_KEY;
	} else {
		process.env.MERGE_GATEWAY_API_KEY = originalMergeGatewayApiKey;
	}
});

describe("Merge Gateway models", () => {
	it("registers models by their provider/model catalog slug via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("merge-gateway", "anthropic/claude-sonnet-4-6");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("merge-gateway");
		expect(model.baseUrl).toBe("https://api-gateway.merge.dev/v1/openai");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(64000);
		expect(model.cost).toEqual({ input: 3.0, output: 15.0, cacheRead: 0, cacheWrite: 0 });
		// reasoning_effort is disabled at the provider level: the gateway forwards
		// it to vendors that may not support it, so pi must not send it.
		expect(model.compat).toEqual({
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
		});
	});

	it("registers non-reasoning models across multiple upstream vendors", () => {
		const command = getModel("merge-gateway", "cohere/command-a-03-2025");
		expect(command.provider).toBe("merge-gateway");
		expect(command.baseUrl).toBe("https://api-gateway.merge.dev/v1/openai");
		expect(command.reasoning).toBe(false);

		const nova = getModel("merge-gateway", "amazon/nova-pro");
		expect(nova.reasoning).toBe(false);
		expect(nova.input).toEqual(["text", "image"]);
	});

	it("resolves MERGE_GATEWAY_API_KEY from the environment", () => {
		process.env.MERGE_GATEWAY_API_KEY = "test-merge-gateway-key";

		expect(findEnvKeys("merge-gateway")).toEqual(["MERGE_GATEWAY_API_KEY"]);
		expect(getEnvApiKey("merge-gateway")).toBe("test-merge-gateway-key");
	});
});
