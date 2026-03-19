import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("GigaChat login provider", () => {
	afterEach(() => {
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

	it("prompts for the authorization key, defaults the scope, and exchanges a token via the SDK", async () => {
		const onProgress = vi.fn();
		const onPrompt = vi
			.fn<(_: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>>()
			.mockResolvedValueOnce("Basic base64-key")
			.mockResolvedValueOnce("");

		const credentials = await loginGigaChat({
			onPrompt,
			onProgress,
		});

		expect(onPrompt).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenCalledWith("Requesting GigaChat access token...");
		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			credentials: "base64-key",
			scope: "GIGACHAT_API_PERS",
		});
		expect(credentials).toMatchObject({
			access: "gigachat-access-token",
			refresh: "base64-key",
			authorizationKey: "base64-key",
			scope: "GIGACHAT_API_PERS",
		});
		expect(credentials.expires).toBe(1_893_456_000_000 - 60_000);
	});

	it("refreshes by reusing the stored authorization key and scope via the SDK", async () => {
		mockState.nextToken = {
			access_token: "gigachat-refreshed-token",
			expires_at: 1_893_460_000,
		};

		const credentials = await refreshGigaChatToken("stored-key", "GIGACHAT_API_CORP");

		expect(mockState.instances).toHaveLength(1);
		expect(mockState.instances[0]?.config).toEqual({
			credentials: "stored-key",
			scope: "GIGACHAT_API_CORP",
		});
		expect(credentials).toMatchObject({
			access: "gigachat-refreshed-token",
			refresh: "stored-key",
			authorizationKey: "stored-key",
			scope: "GIGACHAT_API_CORP",
		});
		expect(credentials.expires).toBe(1_893_460_000_000 - 60_000);
	});
});
