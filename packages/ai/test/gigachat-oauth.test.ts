import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.js";
import type { OAuthPrompt } from "../src/utils/oauth/types.js";

const mockState = vi.hoisted(() => ({
	instances: [] as Array<{
		config: Record<string, unknown>;
		_accessToken?: { access_token?: unknown; expires_at?: unknown };
	}>,
	nextToken: {
		access_token: "gigachat-access-token",
		expires_at: 1_893_456_000,
	},
	error: undefined as Error | undefined,
}));

vi.mock("gigachat", () => {
	class MockGigaChat {
		_accessToken?: { access_token?: unknown; expires_at?: unknown };
		config: Record<string, unknown>;

		constructor(config: Record<string, unknown>) {
			this.config = config;
			mockState.instances.push(this);
		}

		async updateToken(): Promise<void> {
			if (mockState.error) {
				throw mockState.error;
			}
			this._accessToken = { ...mockState.nextToken };
		}
	}

	return {
		default: MockGigaChat,
	};
});

import { loginGigaChat, refreshGigaChatToken } from "../src/utils/oauth/gigachat.js";
import { getOAuthProvider } from "../src/utils/oauth/index.js";

const DEFAULT_BASE_URL = "https://gigachat.devices.sberbank.ru/api/v1";

describe("GigaChat login provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		mockState.instances.length = 0;
		mockState.nextToken = {
			access_token: "gigachat-access-token",
			expires_at: 1_893_456_000,
		};
		mockState.error = undefined;
	});

	it("registers gigachat in the login provider registry", () => {
		expect(getOAuthProvider("gigachat")?.name).toBe("GigaChat");
	});

	it("prompts for account type, auth mode, scope, and base URL before default personal basic auth", async () => {
		const onProgress = vi.fn();
		const onPrompt = vi
			.fn<(_: OAuthPrompt) => Promise<string>>()
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("gigachat-user")
			.mockResolvedValueOnce("gigachat-password");

		const credentials = await loginGigaChat({
			onPrompt,
			onProgress,
		});

		expect(onPrompt).toHaveBeenCalledTimes(6);
		expect(onPrompt.mock.calls.map(([prompt]) => prompt.message)).toEqual([
			"GigaChat account type (personal/business)",
			"GigaChat auth mode (basic/token)",
			"GigaChat scope",
			"GigaChat base URL",
			"GigaChat username",
			"GigaChat password",
		]);
		expect(onPrompt.mock.calls[0]?.[0].choices).toEqual(["Personal", "Business"]);
		expect(onPrompt.mock.calls[1]?.[0].choices).toEqual(["Basic", "Token"]);
		expect(onPrompt.mock.calls[2]?.[0].choices).toEqual([
			"Personal (GIGACHAT_API_PERS)",
			"B2B (GIGACHAT_API_B2B)",
			"Corp (GIGACHAT_API_CORP)",
		]);
		expect(onPrompt.mock.calls[3]?.[0].choices).toEqual([`Default (${DEFAULT_BASE_URL})`, "Custom"]);
		expect(onProgress).toHaveBeenCalledWith("Requesting GigaChat access token...");
		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			user: "gigachat-user",
			password: "gigachat-password",
			baseUrl: DEFAULT_BASE_URL,
		});
		expect(credentials).toMatchObject({
			access: "gigachat-access-token",
			refresh: "",
			authMode: "basic",
			accountType: "personal",
			scope: "GIGACHAT_API_PERS",
			baseUrl: DEFAULT_BASE_URL,
			user: "gigachat-user",
			password: "gigachat-password",
		});
		expect(credentials.expires).toBe(1_893_456_000_000 - 60_000);
	});

	it("refreshes basic auth by reusing stored username, password, scope, and base URL via the SDK", async () => {
		mockState.nextToken = {
			access_token: "gigachat-refreshed-password-token",
			expires_at: 1_893_460_000,
		};

		const provider = getOAuthProvider("gigachat");
		const credentials = await provider?.refreshToken({
			access: "stale-token",
			refresh: "",
			expires: 0,
			authMode: "basic",
			accountType: "business",
			scope: "GIGACHAT_API_CORP",
			baseUrl: "https://gigachat.example/api/v1/",
			user: "stored-user",
			password: "stored-password",
		});

		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			user: "stored-user",
			password: "stored-password",
			baseUrl: "https://gigachat.example/api/v1",
		});
		expect(credentials).toMatchObject({
			access: "gigachat-refreshed-password-token",
			authMode: "basic",
			accountType: "business",
			scope: "GIGACHAT_API_CORP",
			baseUrl: "https://gigachat.example/api/v1",
			user: "stored-user",
			password: "stored-password",
		});
	});

	it("supports custom scope and custom base URL for business basic auth", async () => {
		const onPrompt = vi
			.fn<(_: OAuthPrompt) => Promise<string>>()
			.mockResolvedValueOnce("business")
			.mockResolvedValueOnce("basic")
			.mockResolvedValueOnce("Corp (GIGACHAT_API_CORP)")
			.mockResolvedValueOnce("Custom")
			.mockResolvedValueOnce("https://gigachat.example/api/v1/")
			.mockResolvedValueOnce("business-user")
			.mockResolvedValueOnce("business-password");

		const credentials = await loginGigaChat({ onPrompt });

		expect(onPrompt.mock.calls.map(([prompt]) => prompt.message)).toEqual([
			"GigaChat account type (personal/business)",
			"GigaChat auth mode (basic/token)",
			"GigaChat scope",
			"GigaChat base URL",
			"Custom GigaChat base URL",
			"GigaChat username",
			"GigaChat password",
		]);
		expect(onPrompt.mock.calls[2]?.[0].choices).toEqual([
			"B2B (GIGACHAT_API_B2B)",
			"Corp (GIGACHAT_API_CORP)",
			"Personal (GIGACHAT_API_PERS)",
		]);
		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			user: "business-user",
			password: "business-password",
			baseUrl: "https://gigachat.example/api/v1",
		});
		expect(credentials).toMatchObject({
			authMode: "basic",
			accountType: "business",
			scope: "GIGACHAT_API_CORP",
			baseUrl: "https://gigachat.example/api/v1",
			user: "business-user",
			password: "business-password",
		});
	});

	it("exchanges token credentials via the SDK for personal token auth with default scope and base URL", async () => {
		const onProgress = vi.fn();
		const onPrompt = vi
			.fn<(_: OAuthPrompt) => Promise<string>>()
			.mockResolvedValueOnce("personal")
			.mockResolvedValueOnce("token")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("Basic personal-token-credentials");

		const credentials = await loginGigaChat({
			onPrompt,
			onProgress,
		});

		expect(onPrompt.mock.calls.map(([prompt]) => prompt.message)).toEqual([
			"GigaChat account type (personal/business)",
			"GigaChat auth mode (basic/token)",
			"GigaChat scope",
			"GigaChat base URL",
			"GigaChat token",
		]);
		expect(onProgress).toHaveBeenCalledWith("Requesting GigaChat access token...");
		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			credentials: "personal-token-credentials",
			scope: "GIGACHAT_API_PERS",
			baseUrl: DEFAULT_BASE_URL,
		});
		expect(credentials).toEqual({
			access: "gigachat-access-token",
			refresh: "personal-token-credentials",
			expires: 1_893_456_000_000 - 60_000,
			authMode: "token",
			accountType: "personal",
			authorizationKey: "personal-token-credentials",
			scope: "GIGACHAT_API_PERS",
			baseUrl: DEFAULT_BASE_URL,
		});
	});

	it("defaults business token auth to the B2B scope and default base URL", async () => {
		const onPrompt = vi
			.fn<(_: OAuthPrompt) => Promise<string>>()
			.mockResolvedValueOnce("business")
			.mockResolvedValueOnce("token")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("business-token-credentials");

		const credentials = await loginGigaChat({ onPrompt });

		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			credentials: "business-token-credentials",
			scope: "GIGACHAT_API_B2B",
			baseUrl: DEFAULT_BASE_URL,
		});
		expect(credentials).toMatchObject({
			authMode: "token",
			accountType: "business",
			authorizationKey: "business-token-credentials",
			scope: "GIGACHAT_API_B2B",
			baseUrl: DEFAULT_BASE_URL,
		});
	});

	it("refreshes by reusing the stored authorization key, scope, and base URL via the SDK", async () => {
		mockState.nextToken = {
			access_token: "gigachat-refreshed-token",
			expires_at: 1_893_460_000,
		};

		const credentials = await refreshGigaChatToken("stored-key", "GIGACHAT_API_CORP", {
			baseUrl: "https://gigachat.example/api/v1/",
		});

		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			credentials: "stored-key",
			scope: "GIGACHAT_API_CORP",
			baseUrl: "https://gigachat.example/api/v1",
		});
		expect(credentials).toMatchObject({
			access: "gigachat-refreshed-token",
			refresh: "stored-key",
			authorizationKey: "stored-key",
			scope: "GIGACHAT_API_CORP",
			baseUrl: "https://gigachat.example/api/v1",
		});
		expect(credentials.expires).toBe(1_893_460_000_000 - 60_000);
	});

	it("applies the stored base URL to gigachat models after login", () => {
		const provider = getOAuthProvider("gigachat");
		const models: Model<"gigachat">[] = [
			{
				id: "GigaChat-2",
				name: "GigaChat-2",
				api: "gigachat",
				provider: "gigachat",
				baseUrl: DEFAULT_BASE_URL,
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: 131072,
				maxTokens: 8192,
			},
		];

		const modified = provider?.modifyModels?.(models, {
			access: "stored-access-token",
			refresh: "stored-refresh-token",
			expires: Date.now() + 60_000,
			baseUrl: "https://gigachat.example/api/v1/",
		});

		expect(modified?.[0]?.baseUrl).toBe("https://gigachat.example/api/v1");
	});

	it("fails early for copied multi-scope examples during refresh", async () => {
		await expect(
			refreshGigaChatToken("stored-key", "GIGACHAT_API_PERS / GIGACHAT_API_B2B / GIGACHAT_API_CORP" as never),
		).rejects.toThrow("Set exactly one of GIGACHAT_API_PERS, GIGACHAT_API_B2B, or GIGACHAT_API_CORP");
	});

	it("asks for re-login when legacy token credentials are missing the original exchange key", async () => {
		const provider = getOAuthProvider("gigachat");
		await expect(
			provider?.refreshToken({
				access: "legacy-direct-access-token",
				refresh: "",
				expires: 0,
				authMode: "token",
			}),
		).rejects.toThrow("GigaChat token login is missing the original credentials key");
	});

	it("fails when basic-auth credentials are missing username or password", async () => {
		const provider = getOAuthProvider("gigachat");
		await expect(
			provider?.refreshToken({
				access: "stale-token",
				refresh: "",
				expires: 0,
				authMode: "basic",
				user: "stored-user",
			}),
		).rejects.toThrow("GigaChat credentials missing username or password");
	});
});
