import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalZaiCodingCnApiKey = process.env.ZAI_CODING_CN_API_KEY;
const originalLlmGatewayApiKey = process.env.LLMGATEWAY_API_KEY;
const originalLlmGatewayDevpassApiKey = process.env.LLMGATEWAY_DEVPASS_API_KEY;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicOauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalZaiCodingCnApiKey === undefined) {
		delete process.env.ZAI_CODING_CN_API_KEY;
	} else {
		process.env.ZAI_CODING_CN_API_KEY = originalZaiCodingCnApiKey;
	}

	if (originalLlmGatewayApiKey === undefined) {
		delete process.env.LLMGATEWAY_API_KEY;
	} else {
		process.env.LLMGATEWAY_API_KEY = originalLlmGatewayApiKey;
	}

	if (originalLlmGatewayDevpassApiKey === undefined) {
		delete process.env.LLMGATEWAY_DEVPASS_API_KEY;
	} else {
		process.env.LLMGATEWAY_DEVPASS_API_KEY = originalLlmGatewayDevpassApiKey;
	}

	if (originalAnthropicAuthToken === undefined) {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
	} else {
		process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
	}

	if (originalAnthropicOauthToken === undefined) {
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
	} else {
		process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOauthToken;
	}

	if (originalAnthropicApiKey === undefined) {
		delete process.env.ANTHROPIC_API_KEY;
	} else {
		process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
	}
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("resolves ZAI China Coding Plan credentials from ZAI_CODING_CN_API_KEY", () => {
		process.env.ZAI_CODING_CN_API_KEY = "zai-coding-cn-token";

		expect(findEnvKeys("zai-coding-cn")).toEqual(["ZAI_CODING_CN_API_KEY"]);
		expect(getEnvApiKey("zai-coding-cn")).toBe("zai-coding-cn-token");
	});

	it("resolves LLM Gateway credentials from LLMGATEWAY_API_KEY", () => {
		process.env.LLMGATEWAY_API_KEY = "llmgtwy-token";

		expect(findEnvKeys("llmgateway")).toEqual(["LLMGATEWAY_API_KEY"]);
		expect(getEnvApiKey("llmgateway")).toBe("llmgtwy-token");
	});

	it("keeps LLM Gateway DevPass credentials on their own env var", () => {
		process.env.LLMGATEWAY_API_KEY = "llmgtwy-token";
		process.env.LLMGATEWAY_DEVPASS_API_KEY = "llmgtwy-devpass-token";

		expect(findEnvKeys("llmgateway-devpass")).toEqual(["LLMGATEWAY_DEVPASS_API_KEY"]);
		expect(getEnvApiKey("llmgateway-devpass")).toBe("llmgtwy-devpass-token");
		expect(getEnvApiKey("llmgateway")).toBe("llmgtwy-token");
	});

	it("reports ANTHROPIC_AUTH_TOKEN but preserves OAuth token API key lookup", () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
		expect(getEnvApiKey("anthropic")).toBe("oauth-token");
	});

	it("does not return ANTHROPIC_AUTH_TOKEN as an API key", () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_API_KEY;

		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
		expect(getEnvApiKey("anthropic")).toBeUndefined();
	});

	it("preserves ANTHROPIC_OAUTH_TOKEN as an API key", () => {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		delete process.env.ANTHROPIC_API_KEY;

		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN"]);
		expect(getEnvApiKey("anthropic")).toBe("oauth-token");
	});

	it("falls back to ANTHROPIC_API_KEY for API key lookup", () => {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(getEnvApiKey("anthropic")).toBe("api-key");
	});
});
