import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loginOpenAICodex,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "../src/utils/oauth/openai-codex.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createAccessToken(accountId = "acct_123"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64url");
	return `header.${payload}.sig`;
}

describe("OpenAI Codex OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("waits before polling, retries 403/404 device polls, and returns OAuth credentials", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-25T00:00:00Z");
		vi.setSystemTime(startTime);

		const pollTimes: number[] = [];
		const authUrls: Array<{ url: string; instructions?: string }> = [];
		const accessToken = createAccessToken();
		const pollResponses = [
			jsonResponse({ message: "pending" }, 403),
			jsonResponse({ message: "still pending" }, 404),
			jsonResponse({
				authorization_code: "device-authorization-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					"Content-Type": "application/json",
				});
				expect(String(init?.body)).toContain('"client_id"');
				return jsonResponse({
					user_code: "ABCD-EFGH",
					device_auth_id: "device-auth-id",
					interval: "5",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					"Content-Type": "application/json",
				});
				expect(String(init?.body)).toContain('"device_auth_id":"device-auth-id"');
				expect(String(init?.body)).toContain('"user_code":"ABCD-EFGH"');
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(String(init?.body)).toContain("grant_type=authorization_code");
				expect(String(init?.body)).toContain("code=device-authorization-code");
				expect(String(init?.body)).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginOpenAICodex({
			onAuth: (info) => authUrls.push(info),
			onPrompt: async () => "device",
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(authUrls).toEqual([
			{ url: "https://auth.openai.com/codex/device", instructions: "Enter code: ABCD-EFGH" },
		]);
		expect(pollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		await expect(loginPromise).resolves.toEqual({
			access: accessToken,
			refresh: "refresh-token",
			expires: startTime.getTime() + 15000 + 3600 * 1000,
			accountId: "acct_123",
		});

		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10000, startTime.getTime() + 15000]);
	});

	it("supports cancellation while waiting to poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				return jsonResponse({
					user_code: "ABCD-EFGH",
					device_auth_id: "device-auth-id",
					interval: "5",
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = openaiCodexOAuthProvider.login({
			onAuth: () => {},
			onPrompt: async () => "device",
			signal: controller.signal,
		});
		const rejection = expect(loginPromise).rejects.toThrow("Login cancelled");

		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);

		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("supports base64url JWT payloads in device flow tokens", async () => {
		vi.useFakeTimers();
		const accessToken = createAccessToken("acct_-_");

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				return jsonResponse({
					user_code: "ABCD-EFGH",
					device_auth_id: "device-auth-id",
					interval: "1",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				return jsonResponse({
					authorization_code: "device-authorization-code",
					code_challenge: "device-code-challenge",
					code_verifier: "device-code-verifier",
				});
			}

			if (url === "https://auth.openai.com/oauth/token") {
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginOpenAICodex({
			onAuth: () => {},
			onPrompt: async () => "device",
		});

		await vi.advanceTimersByTimeAsync(1200);

		await expect(loginPromise).resolves.toMatchObject({
			accountId: "acct_-_",
		});
	});

	it("accepts headless as the device login alias", async () => {
		vi.useFakeTimers();
		const accessToken = createAccessToken("acct_headless");
		const authUrls: Array<{ url: string; instructions?: string }> = [];

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				return jsonResponse({
					user_code: "WXYZ-1234",
					device_auth_id: "device-auth-id",
					interval: "1",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				return jsonResponse({
					authorization_code: "device-authorization-code",
					code_challenge: "device-code-challenge",
					code_verifier: "device-code-verifier",
				});
			}

			if (url === "https://auth.openai.com/oauth/token") {
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-headless",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginOpenAICodex({
			onAuth: (info) => authUrls.push(info),
			onPrompt: async () => "headless",
		});

		await vi.advanceTimersByTimeAsync(1200);

		await expect(loginPromise).resolves.toMatchObject({
			accountId: "acct_headless",
		});
		expect(authUrls[0]?.url).toBe("https://auth.openai.com/codex/device");
	});

	it("refreshes the token and preserves accountId extraction", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-25T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessToken = createAccessToken("acct_456");
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url !== "https://auth.openai.com/oauth/token") {
				throw new Error(`Unexpected fetch URL: ${url}`);
			}

			expect(init?.method).toBe("POST");
			expect(String(init?.body)).toContain("grant_type=refresh_token");
			expect(String(init?.body)).toContain("refresh_token=refresh-token");
			return jsonResponse({
				access_token: accessToken,
				refresh_token: "refresh-token-2",
				expires_in: 1800,
			});
		});

		vi.stubGlobal("fetch", fetchMock);

		await expect(refreshOpenAICodexToken("refresh-token")).resolves.toEqual({
			access: accessToken,
			refresh: "refresh-token-2",
			expires: startTime.getTime() + 1800 * 1000,
			accountId: "acct_456",
		});
	});

	it("uses callback flow when browser login method is selected", async () => {
		const authUrls: Array<{ url: string; instructions?: string }> = [];
		const accessToken = createAccessToken("acct_callback");

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(String(init?.body)).toContain("grant_type=authorization_code");
				expect(String(init?.body)).toContain("code=callback-code");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-callback",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: (info) => authUrls.push(info),
				onPrompt: async () => "browser",
				onManualCodeInput: async () => "callback-code",
			}),
		).resolves.toEqual({
			access: accessToken,
			refresh: "refresh-callback",
			expires: expect.any(Number),
			accountId: "acct_callback",
		});

		expect(authUrls).toHaveLength(1);
		expect(authUrls[0]?.url).toContain("https://auth.openai.com/oauth/authorize?");
	});

	it("falls back to browser callback flow when headless login is blocked", async () => {
		const authUrls: Array<{ url: string; instructions?: string }> = [];
		const progressMessages: string[] = [];
		const accessToken = createAccessToken("acct_callback_fallback");

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				return new Response("<!DOCTYPE html><title>Just a moment...</title>", {
					status: 403,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(String(init?.body)).toContain("grant_type=authorization_code");
				expect(String(init?.body)).toContain("code=callback-code");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-callback",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: (info) => authUrls.push(info),
				onPrompt: async () => "headless",
				onManualCodeInput: async () => "callback-code",
				onProgress: (message) => progressMessages.push(message),
			}),
		).resolves.toEqual({
			access: accessToken,
			refresh: "refresh-callback",
			expires: expect.any(Number),
			accountId: "acct_callback_fallback",
		});

		expect(authUrls).toHaveLength(1);
		expect(authUrls[0]?.url).toContain("https://auth.openai.com/oauth/authorize?");
		expect(progressMessages).toContain("Headless login blocked; switching to browser login...");
	});

	it("supports cancellation while waiting for callback login", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("Token exchange should not run after abort");
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginOpenAICodex({
			onAuth: () => {},
			onPrompt: async () => {
				await new Promise(() => {});
				return "";
			},
			onManualCodeInput: async () => {
				await new Promise(() => {});
				return "";
			},
			signal: controller.signal,
		});

		controller.abort();

		await expect(loginPromise).rejects.toThrow("Login cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects invalid login method from prompt", async () => {
		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "bad-method",
			}),
		).rejects.toThrow("Invalid login method: bad-method. Expected headless or browser.");
	});
});
