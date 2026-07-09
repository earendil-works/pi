import { afterEach, describe, expect, it, vi } from "vitest";
import { loginXaiOAuth, refreshXaiOAuthToken, xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
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
		verification_uri_complete: "https://untrusted.example/?user_code=ABCD-1234",
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

function stalledResponse(signal: AbortSignal | null | undefined, errorMessage: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				const fail = () => controller.error(new Error(errorMessage));
				if (signal?.aborted) {
					fail();
				} else {
					signal?.addEventListener("abort", fail, { once: true });
				}
			},
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected promise to reject");
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
			expect(init?.redirect).toBe("error");
			expect(init?.credentials).toBe("omit");
			expect(init?.referrerPolicy).toBe("no-referrer");

			if (url === "https://auth.x.ai/oauth2/device/code") {
				const form = requestForm(init);
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
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

		const deviceCodes: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const loginPromise = loginXaiOAuth({ onDeviceCode: (info) => deviceCodes.push(info) });

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
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 20_000 + 21_600_000 - 300_000,
		});
	});

	it.each([
		"http://accounts.x.ai/oauth2/device",
		"https://evil.example/oauth2/device",
		"https://user@accounts.x.ai/oauth2/device",
		"https://accounts.x.ai:444/oauth2/device",
	])("rejects an untrusted verification URI: %s", async (verificationUri) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(deviceCodeResponse({ verification_uri: verificationUri }))),
		);

		await expect(loginXaiOAuth({ onDeviceCode: () => {} })).rejects.toThrow("Untrusted verification URI");
	});

	it.each([{ interval: 0 }, { interval: 301 }, { expires_in: 0 }, { expires_in: 3601 }])(
		"rejects invalid device timing fields: %j",
		async (overrides) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse(deviceCodeResponse(overrides))),
			);

			await expect(loginXaiOAuth({ onDeviceCode: () => {} })).rejects.toThrow("Invalid xAI OAuth response field");
		},
	);

	it("rejects oversized responses before parsing them", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(deviceCodeResponse(), 200, {
					"Content-Length": String(256 * 1024 + 1),
				}),
			),
		);

		await expect(loginXaiOAuth({ onDeviceCode: () => {} })).rejects.toThrow(
			"xAI OAuth response exceeded the size limit",
		);
	});

	it.each([
		["access_denied", "xAI device authorization was denied"],
		["authorization_denied", "xAI device authorization was denied"],
		["expired_token", "xAI device code expired"],
	])("handles terminal device errors without exposing descriptions: %s", async (error, expectedMessage) => {
		vi.useFakeTimers();
		let requestCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestCount += 1;
				return requestCount === 1
					? jsonResponse(deviceCodeResponse({ interval: 1 }))
					: jsonResponse({ error, error_description: "sensitive upstream detail" }, 400);
			}),
		);

		const loginPromise = loginXaiOAuth({ onDeviceCode: () => {} });
		const messagePromise = rejectionMessage(loginPromise);
		await vi.advanceTimersByTimeAsync(1000);
		const message = await messagePromise;
		expect(message).toBe(expectedMessage);
		expect(message).not.toContain("sensitive upstream detail");
	});

	it("cancels while waiting for the first token poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => jsonResponse(deviceCodeResponse()));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginXaiOAuth({
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

		const rotated = await refreshXaiOAuthToken("old-refresh");
		const preserved = await refreshXaiOAuthToken("keep-refresh");
		expect(rotated.refresh).toBe("new-refresh");
		expect(rotated.access).toBe("new-access");
		expect(preserved.refresh).toBe("keep-refresh");
		expect(preserved.access).toBe("newer-access");
		expect(xaiOAuthProvider.id).toBe("xai");
		expect(xaiOAuthProvider.name).toBe("xAI");
		expect(xaiOAuthProvider.getApiKey(preserved)).toBe("newer-access");
	});

	it("rejects malformed token responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ token_type: "Basic", refresh_token: undefined }))),
		);

		await expect(refreshXaiOAuthToken("old-refresh")).rejects.toThrow("Invalid xAI OAuth response field: token_type");
	});

	it("reports request timeouts without exposing transport errors", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_input: unknown, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new Error("transport included sensitive-token")),
							{ once: true },
						);
					}),
			),
		);

		const refreshPromise = refreshXaiOAuthToken("sensitive-refresh-token");
		const messagePromise = rejectionMessage(refreshPromise);
		timeoutController.abort();
		const message = await messagePromise;
		expect(message).toBe("xAI OAuth request timed out");
		expect(message).not.toContain("sensitive");
	});

	it("normalizes timeout and cancellation errors while reading a response body", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) =>
				stalledResponse(init?.signal, "body included sensitive-token"),
			),
		);

		const timeoutPromise = rejectionMessage(refreshXaiOAuthToken("sensitive-refresh-token"));
		await Promise.resolve();
		timeoutController.abort();
		const timeoutMessage = await timeoutPromise;
		expect(timeoutMessage).toBe("xAI OAuth request timed out");
		expect(timeoutMessage).not.toContain("sensitive");

		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		const cancelController = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) =>
				stalledResponse(init?.signal, "body included sensitive-token"),
			),
		);
		const cancelPromise = rejectionMessage(refreshXaiOAuthToken("sensitive-refresh-token", cancelController.signal));
		await Promise.resolve();
		cancelController.abort();
		const cancelMessage = await cancelPromise;
		expect(cancelMessage).toBe("Login cancelled");
		expect(cancelMessage).not.toContain("sensitive");
	});

	it("backs off and retries a timed-out device token poll", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		const timeoutControllers: AbortController[] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const controller = new AbortController();
			timeoutControllers.push(controller);
			return controller.signal;
		});

		const pollTimes: number[] = [];
		let requestCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				requestCount += 1;
				if (requestCount === 1) {
					return jsonResponse(deviceCodeResponse({ interval: 1 }));
				}
				pollTimes.push(Date.now());
				if (requestCount === 2) {
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("poll timed out")), {
							once: true,
						});
					});
				}
				return jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = loginXaiOAuth({ onDeviceCode: () => {} });
		await vi.advanceTimersByTimeAsync(1000);
		expect(pollTimes).toEqual([startTime.getTime() + 1000]);
		timeoutControllers[1]?.abort();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6000);
		await expect(loginPromise).resolves.toMatchObject({ access: "access-token" });
		expect(pollTimes).toEqual([startTime.getTime() + 1000, startTime.getTime() + 7000]);
	});
});
