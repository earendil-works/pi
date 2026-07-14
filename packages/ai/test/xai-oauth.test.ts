import { afterEach, describe, expect, it, vi } from "vitest";
import { loginXai, loginXaiDeviceCode, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("xAI OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("logs in with authorization-code PKCE through manual callback input", async () => {
		let authUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				expect(urlOf(input)).toBe("https://auth.x.ai/oauth2/token");
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
				expect(params.get("code_verifier")).toBeTruthy();
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}),
		);

		const credentials = await loginXai({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state");
				return `http://127.0.0.1:56121/callback?code=manual-code&state=${state}`;
			},
		});

		expect(credentials).toMatchObject({ access: "access", refresh: "refresh" });
	});

	it("logs in with the xAI device-code flow", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));
		const events: Array<{ userCode: string; verificationUri: string }> = [];
		let polls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = urlOf(input);
				const params = new URLSearchParams(String(init?.body));
				if (url.endsWith("/oauth2/device/code")) {
					expect(params.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
					expect(params.get("scope")).toContain("grok-cli:access");
					return jsonResponse({
						device_code: "device-token",
						user_code: "GROK-CODE",
						verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=GROK-CODE",
						expires_in: 600,
						interval: 1,
					});
				}
				if (url.endsWith("/oauth2/token")) {
					expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
					polls += 1;
					return polls === 1
						? jsonResponse({ error: "authorization_pending" }, 400)
						: jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		const resultPromise = loginXaiDeviceCode({ onDeviceCode: (event) => events.push(event) });
		await vi.advanceTimersByTimeAsync(1000);
		expect(polls).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(resultPromise).resolves.toMatchObject({ access: "access", refresh: "refresh" });
		expect(events).toEqual([
			{
				userCode: "GROK-CODE",
				verificationUri: "https://accounts.x.ai/oauth2/device?user_code=GROK-CODE",
				intervalSeconds: 1,
				expiresInSeconds: 600,
			},
		]);
	});

	it("refreshes xAI tokens and preserves a non-rotated refresh token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("old-refresh");
				return jsonResponse({ access_token: "new-access", expires_in: 3600 });
			}),
		);
		await expect(refreshXaiToken("old-refresh")).resolves.toMatchObject({
			access: "new-access",
			refresh: "old-refresh",
		});
	});

	it("offers browser and headless login methods", async () => {
		await expect(
			xaiOAuthProvider.login({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async (prompt) => {
					expect(prompt.options).toEqual([
						{ id: "browser", label: "Browser login (default)" },
						{ id: "device_code", label: "Device code login (headless)" },
					]);
					return undefined;
				},
			}),
		).rejects.toThrow("Login cancelled");
	});
});
