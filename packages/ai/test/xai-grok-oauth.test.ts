import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import { refreshXaiGrokToken, xaiGrokOAuthProvider } from "../src/utils/oauth/xai-grok.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getFormBody(init?: RequestInit): URLSearchParams {
	if (!(init?.body instanceof URLSearchParams)) {
		throw new Error(`Expected URLSearchParams request body, got ${typeof init?.body}`);
	}
	return init.body;
}

describe("xAI Grok OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("registers xAI Grok as a built-in OAuth provider", () => {
		expect(getOAuthProvider("xai-grok")).toBe(xaiGrokOAuthProvider);
	});

	it("logs in with xAI's OIDC device-code flow without asking for a second login method", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-06-14T00:00:00Z");
		vi.setSystemTime(startTime);

		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const pollTimes: number[] = [];
		const tokenResponses = [
			jsonResponse({ error: "authorization_pending", error_description: "waiting" }, 400),
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.x.ai/.well-known/openid-configuration") {
				return jsonResponse({
					issuer: "https://auth.x.ai",
					token_endpoint: "https://auth.x.ai/oauth2/token",
					device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
				});
			}

			if (url === "https://auth.x.ai/oauth2/device/code") {
				expect(init?.method).toBe("POST");
				const body = getFormBody(init);
				expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(body.get("scope")).toContain("grok-cli:access");
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-EFGH",
					interval: 2,
					expires_in: 900,
				});
			}

			if (url === "https://auth.x.ai/oauth2/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				const body = getFormBody(init);
				expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(body.get("device_code")).toBe("device-code");
				expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				const response = tokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentialsPromise = xaiGrokOAuthProvider.login({
			onAuth: () => {
				throw new Error("Browser callback login should not start");
			},
			onDeviceCode: (info) => deviceInfos.push(info),
			onPrompt: async () => {
				throw new Error("Prompt should not be used");
			},
			onSelect: async () => {
				throw new Error("xAI Grok login should not show a second method selector");
			},
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(deviceInfos).toEqual([
			{
				userCode: "ABCD-EFGH",
				verificationUri: "https://auth.x.ai/device?user_code=ABCD-EFGH",
				intervalSeconds: 2,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(1999);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(credentialsPromise).resolves.toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 2000 + 3600 * 1000,
			oidcIssuer: "https://auth.x.ai",
			oidcClientId: "b1a00492-073a-47ea-816f-4c329264a828",
			source: "xai-grok-device-code",
		});
	});

	it("rejects non-HTTPS verification URLs before showing the device code", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.x.ai/.well-known/openid-configuration") {
				return jsonResponse({
					token_endpoint: "https://auth.x.ai/oauth2/token",
					device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
				});
			}
			if (url === "https://auth.x.ai/oauth2/device/code") {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "file:///tmp/not-a-browser-url",
					interval: 1,
					expires_in: 900,
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onDeviceCode = vi.fn();
		await expect(
			xaiGrokOAuthProvider.login({
				onAuth: () => {},
				onDeviceCode,
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toThrow(/Untrusted verification_uri/);
		expect(onDeviceCode).not.toHaveBeenCalled();
	});

	it("refreshes xAI Grok tokens and preserves the refresh token if xAI does not rotate it", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.x.ai/.well-known/openid-configuration") {
				return jsonResponse({
					token_endpoint: "https://auth.x.ai/oauth2/token",
					device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
				});
			}
			if (url === "https://auth.x.ai/oauth2/token") {
				expect(init?.method).toBe("POST");
				const body = getFormBody(init);
				expect(body.get("grant_type")).toBe("refresh_token");
				expect(body.get("refresh_token")).toBe("old-refresh-token");
				expect(body.get("client_id")).toBe("client-from-credentials");
				return jsonResponse({
					access_token: "new-access-token",
					expires_in: 1800,
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		await expect(
			refreshXaiGrokToken({
				access: "old-access-token",
				refresh: "old-refresh-token",
				expires: 0,
				oidcIssuer: "https://auth.x.ai",
				oidcClientId: "client-from-credentials",
			}),
		).resolves.toMatchObject({
			access: "new-access-token",
			refresh: "old-refresh-token",
			oidcIssuer: "https://auth.x.ai",
			oidcClientId: "client-from-credentials",
			source: "xai-grok-refresh-token",
		});
	});
});
