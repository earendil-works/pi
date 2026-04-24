import { setKeybindings } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { getApiKeyProviderDisplayName, isApiKeyLoginProvider } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		if (originalOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalOpenAiApiKey;
		}
	});

	it("keeps built-in API key providers separate from OAuth-only providers", () => {
		const oauthProviderIds = new Set(["anthropic", "github-copilot", "custom-oauth"]);
		const builtInProviderIds = new Set(["anthropic", "github-copilot", "amazon-bedrock", "openai"]);

		expect(isApiKeyLoginProvider("anthropic", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(getApiKeyProviderDisplayName("anthropic")).toBe("Anthropic");
		expect(isApiKeyLoginProvider("openai", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("github-copilot", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("amazon-bedrock", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("custom-oauth", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("custom-api", oauthProviderIds, builtInProviderIds)).toBe(true);
	});

	it("shows environment API key auth while keeping provider unconfigured", () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "openai", name: "OpenAI", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("OpenAI");
		expect(output).toContain("unconfigured");
		expect(output).toContain("env: OPENAI_API_KEY");
	});
});
