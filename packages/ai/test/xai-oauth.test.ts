import { afterEach, describe, expect, it, vi } from "vitest";
import { loginXaiOAuth, refreshXaiOAuthToken, xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

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

describe("xAI Grok OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("logs in with the xAI device code flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-05-20T00:00:00Z");
		vi.setSystemTime(startTime);

		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 21600,
				token_type: "Bearer",
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.x.ai/.well-known/openid-configuration") {
				return jsonResponse({
					authorization_endpoint: "https://auth.x.ai/oauth2/auth",
					token_endpoint: "https://auth.x.ai/oauth2/token",
				});
			}

			if (url === "https://auth.x.ai/oauth2/device/code") {
				expect(init?.method).toBe("POST");
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(body.get("scope")).toContain("grok-cli:access");
				return jsonResponse({
					device_code: "device-code",
					user_code: "WXYZ-9876",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?user_code=WXYZ-9876",
					expires_in: 900,
					interval: 5,
				});
			}

			if (url === "https://auth.x.ai/oauth2/token") {
				pollTimes.push(Date.now());
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(body.get("device_code")).toBe("device-code");
				const response = pollResponses.shift();
				if (!response) throw new Error("Unexpected extra token poll");
				return response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const resultPromise = loginXaiOAuth({
			onDeviceCode: (info) => {
				deviceInfos.push(info);
			},
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(deviceInfos).toEqual([
			{
				userCode: "WXYZ-9876",
				verificationUri: "https://auth.x.ai/device?user_code=WXYZ-9876",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(5000);
		const credentials = await resultPromise;
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.expires).toBeLessThan(Date.now() + 21600 * 1000);
		expect(xaiOAuthProvider.id).toBe("xai-oauth");
	});

	it("refreshes xAI OAuth tokens", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.x.ai/.well-known/openid-configuration") {
				return jsonResponse({
					authorization_endpoint: "https://auth.x.ai/oauth2/auth",
					token_endpoint: "https://auth.x.ai/oauth2/token",
				});
			}
			if (url === "https://auth.x.ai/oauth2/token") {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("grant_type")).toBe("refresh_token");
				expect(body.get("refresh_token")).toBe("old-refresh");
				return jsonResponse({
					access_token: "new-access",
					refresh_token: "new-refresh",
					expires_in: 3600,
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshXaiOAuthToken("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("new-refresh");
	});
});
