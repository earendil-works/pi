import { afterEach, describe, expect, it, vi } from "vitest";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function requestForm(init: RequestInit | undefined): URLSearchParams {
	return new URLSearchParams(String(init?.body));
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		device_code: "device-code",
		user_code: "ABCD-1234",
		verification_uri: "https://accounts.x.ai/oauth2/device",
		expires_in: 900,
		interval: 5,
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 21_600,
		token_type: "Bearer",
		...overrides,
	};
}

type DeviceCodeInfo = {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

function loginXaiForTest(options: {
	onDeviceCode: (info: DeviceCodeInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredential> {
	return xaiOAuth.login({
		signal: options.signal,
		prompt: () => {
			throw new Error("Unexpected prompt");
		},
		notify: (event) => {
			if (event.type === "device_code") {
				const { type: _, ...info } = event;
				options.onDeviceCode(info);
			}
		},
	});
}

function refreshXaiForTest(refreshToken: string): Promise<OAuthCredential> {
	return xaiOAuth.refresh({ type: "oauth", access: "old-access", refresh: refreshToken, expires: 0 });
}

describe("xAI OAuth device flow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uses the device grant, delays polling, and handles pending and slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		const pollTimes: number[] = [];
		const tokenReplies = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 10 }, 400),
			jsonResponse(tokenResponse()),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = requestUrl(input);

			if (url === "https://auth.x.ai/oauth2/device/code") {
				const form = requestForm(init);
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
				expect(form.get("referrer")).toBe("pi");
				return jsonResponse(deviceCodeResponse());
			}

			if (url === "https://auth.x.ai/oauth2/token") {
				pollTimes.push(Date.now());
				const form = requestForm(init);
				expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("device_code")).toBe("device-code");
				const reply = tokenReplies.shift();
				if (!reply) throw new Error("Unexpected token poll");
				return reply;
			}

			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const deviceCodes: DeviceCodeInfo[] = [];
		const loginPromise = loginXaiForTest({ onDeviceCode: (info) => deviceCodes.push(info) });

		await vi.advanceTimersByTimeAsync(0);
		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://accounts.x.ai/oauth2/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toEqual([startTime.getTime() + 5000]);

		// slow_down raised the interval to 10 seconds
		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10_000]);

		await vi.advanceTimersByTimeAsync(10_000);
		const credentials = await loginPromise;
		expect(pollTimes).toEqual([
			startTime.getTime() + 5000,
			startTime.getTime() + 10_000,
			startTime.getTime() + 20_000,
		]);
		expect(credentials).toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 20_000 + 21_600_000 - 300_000,
		});
	});

	it("falls back to the default poll interval when the response reports interval 0", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		const pollTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				if (requestUrl(input) === "https://auth.x.ai/oauth2/device/code") {
					return jsonResponse(deviceCodeResponse({ interval: 0 }));
				}
				pollTimes.push(Date.now());
				return jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = loginXaiForTest({ onDeviceCode: () => {} });
		// RFC 8628 default interval is 5 seconds when the server does not require a wait.
		await vi.advanceTimersByTimeAsync(5000);
		await loginPromise;
		expect(pollTimes).toEqual([startTime.getTime() + 5000]);
	});

	it("prefers verification_uri_complete when the server provides it", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				if (requestUrl(input) === "https://auth.x.ai/oauth2/device/code") {
					return jsonResponse(
						deviceCodeResponse({
							verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
						}),
					);
				}
				return jsonResponse(tokenResponse());
			}),
		);

		const deviceCodes: DeviceCodeInfo[] = [];
		const loginPromise = loginXaiForTest({ onDeviceCode: (info) => deviceCodes.push(info) });
		await vi.advanceTimersByTimeAsync(5000);
		await loginPromise;
		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
	});

	it("rejects a non-https verification_uri_complete", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(
					deviceCodeResponse({
						verification_uri_complete: "http://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
					}),
				),
			),
		);

		await expect(loginXaiForTest({ onDeviceCode: () => {} })).rejects.toThrow("Untrusted verification URI");
	});

	it.each(["http://accounts.x.ai/oauth2/device", "file:///etc/passwd", "not a url"])(
		"rejects a non-https verification URI: %s",
		async (verificationUri) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse(deviceCodeResponse({ verification_uri: verificationUri }))),
			);

			await expect(loginXaiForTest({ onDeviceCode: () => {} })).rejects.toThrow("Untrusted verification URI");
		},
	);

	it.each(["access_denied", "authorization_denied"])(
		"fails when device authorization is denied: %s",
		async (error) => {
			vi.useFakeTimers();
			let requestCount = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					requestCount += 1;
					return requestCount === 1
						? jsonResponse(deviceCodeResponse({ interval: 1 }))
						: jsonResponse({ error }, 400);
				}),
			);

			const loginPromise = loginXaiForTest({ onDeviceCode: () => {} });
			const assertion = expect(loginPromise).rejects.toThrow("xAI device authorization was denied");
			await vi.advanceTimersByTimeAsync(1000);
			await assertion;
		},
	);

	it("cancels while waiting for the first token poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => jsonResponse(deviceCodeResponse()));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginXaiForTest({
			onDeviceCode: () => controller.abort(),
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toThrow("Login cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refreshes tokens and preserves an unrotated refresh token", async () => {
		let requestCount = 0;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(requestUrl(input)).toBe("https://auth.x.ai/oauth2/token");
			const form = requestForm(init);
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
			requestCount += 1;
			if (requestCount === 1) {
				expect(form.get("refresh_token")).toBe("old-refresh");
				return jsonResponse(tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }));
			}
			expect(form.get("refresh_token")).toBe("keep-refresh");
			return jsonResponse(tokenResponse({ access_token: "newer-access", refresh_token: undefined }));
		});
		vi.stubGlobal("fetch", fetchMock);

		const rotated = await refreshXaiForTest("old-refresh");
		const preserved = await refreshXaiForTest("keep-refresh");
		expect(rotated.type).toBe("oauth");
		expect(rotated.refresh).toBe("new-refresh");
		expect(rotated.access).toBe("new-access");
		expect(preserved.refresh).toBe("keep-refresh");
		expect(preserved.access).toBe("newer-access");
		expect(xaiOAuth.name).toBe("xAI (Grok/X subscription)");
		await expect(xaiOAuth.toAuth(preserved)).resolves.toEqual({ apiKey: "newer-access" });
	});

	it("assumes a one-hour lifetime when expires_in is missing", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ expires_in: undefined }))),
		);

		const credentials = await refreshXaiForTest("old-refresh");
		expect(credentials.expires).toBe(startTime.getTime() + 3_600_000 - 300_000);
	});

	it("rejects token responses with missing fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ access_token: undefined }))),
		);

		await expect(refreshXaiForTest("old-refresh")).rejects.toThrow("Invalid xAI OAuth response field: access_token");
	});

	it("surfaces the upstream error code and description on refresh failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "refresh token revoked" }, 400)),
		);

		await expect(refreshXaiForTest("old-refresh")).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 400): invalid_grant: refresh token revoked",
		);
	});
});
