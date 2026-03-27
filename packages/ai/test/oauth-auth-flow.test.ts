import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOAuthProviders, resetOAuthProviders } from "../src/utils/oauth/index.js";

describe("OAuth provider authFlow metadata", () => {
	beforeEach(() => {
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
	});

	it("should expose authFlow for mixed and device providers", () => {
		const providers = getOAuthProviders();

		const openaiCodex = providers.find((p) => p.id === "openai-codex");
		expect(openaiCodex).toBeDefined();
		expect(openaiCodex?.authFlow).toBe("mixed");

		const githubCopilot = providers.find((p) => p.id === "github-copilot");
		expect(githubCopilot).toBeDefined();
		expect(githubCopilot?.authFlow).toBe("device");
	});

	it("should expose authFlow for callback providers", () => {
		const providers = getOAuthProviders();

		const anthropic = providers.find((p) => p.id === "anthropic");
		expect(anthropic).toBeDefined();
		expect(anthropic?.authFlow).toBe("callback");

		const geminiCli = providers.find((p) => p.id === "google-gemini-cli");
		expect(geminiCli).toBeDefined();
		expect(geminiCli?.authFlow).toBe("callback");

		const antigravity = providers.find((p) => p.id === "google-antigravity");
		expect(antigravity).toBeDefined();
		expect(antigravity?.authFlow).toBe("callback");
	});
});
