import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const HOST = "{NEON_AI_GATEWAY_BASE_URL}";

describe("Neon AI Gateway models", () => {
	it("serves each model on its native gateway endpoint", () => {
		expect(getModel("neon-ai-gateway", "claude-opus-5-5")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: `${HOST}/anthropic`,
		});
		expect(getModel("neon-ai-gateway", "gpt-6-1-sol")).toMatchObject({
			api: "openai-responses",
			baseUrl: `${HOST}/openai/v1`,
		});
		expect(getModel("neon-ai-gateway", "gemini-3-8-flash")).toMatchObject({
			api: "google-generative-ai",
			baseUrl: `${HOST}/gemini/v1beta`,
		});
		expect(getModel("neon-ai-gateway", "kimi-k3")).toMatchObject({
			api: "openai-completions",
			baseUrl: `${HOST}/v1`,
		});
	});

	it("keeps Claude effort per request, which the gateway's Anthropic endpoint requires", () => {
		const model = getModel("neon-ai-gateway", "claude-opus-5-5");
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
		expect(model.compat).not.toHaveProperty("supportsMidConvoEffort");
	});

	it("resolves the token from NEON_AI_GATEWAY_TOKEN", () => {
		const env = { NEON_AI_GATEWAY_TOKEN: "test-neon-token" };
		expect(findEnvKeys("neon-ai-gateway", env)).toEqual(["NEON_AI_GATEWAY_TOKEN"]);
		expect(getEnvApiKey("neon-ai-gateway", env)).toBe("test-neon-token");
	});
});
