import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCodexOAuthProvider, refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

function createJwt(payload: object): string {
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `header.${encoded}.signature`;
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("defaults to browser OAuth when no login method selector is available", async () => {
		const accessToken = createJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "account-123",
			},
		});
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			expect(String(input)).toBe("https://auth.openai.com/oauth/token");
			expect(String(init?.body)).toContain("code=browser-code");
			return new Response(
				JSON.stringify({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const authEvents: Array<{ url: string; instructions?: string; manualCodeInput?: boolean }> = [];
		const credentials = await openaiCodexOAuthProvider.login({
			onAuth: (info) => authEvents.push(info),
			onPrompt: async () => {
				throw new Error("should not prompt");
			},
			onManualCodeInput: async () => "browser-code",
		});

		expect(credentials.refresh).toBe("refresh-token");
		expect(authEvents[0]?.url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
		expect(authEvents[0]?.manualCodeInput).not.toBe(false);
	});

	it("uses the selected device-code login flow", async () => {
		const accessToken = createJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "account-123",
			},
		});
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			const url = String(input);
			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(String(init?.body)).toBe(JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }));
				return new Response(
					JSON.stringify({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-EFGH",
						interval: "1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(String(init?.body)).toBe(
					JSON.stringify({ device_auth_id: "device-auth-id", user_code: "ABCD-EFGH" }),
				);
				return new Response(
					JSON.stringify({
						authorization_code: "auth-code",
						code_verifier: "device-verifier",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(String(init?.body)).toContain("code=auth-code");
				expect(String(init?.body)).toContain("code_verifier=device-verifier");
				expect(String(init?.body)).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
				return new Response(
					JSON.stringify({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const authEvents: Array<{ url: string; instructions?: string; manualCodeInput?: boolean }> = [];
		const selected = await openaiCodexOAuthProvider.login({
			onAuth: (info) => authEvents.push(info),
			onPrompt: async () => {
				throw new Error("should not prompt");
			},
			onManualCodeInput: async () => "browser-code",
			onSelect: async (prompt) => {
				expect(prompt.message).toBe("Select ChatGPT login method:");
				expect(prompt.options).toEqual([
					{ id: "browser", label: "Browser OAuth" },
					{ id: "device", label: "Device Code" },
				]);
				return "device";
			},
		});

		expect(selected.refresh).toBe("refresh-token");
		expect(authEvents).toEqual([
			{
				url: "https://auth.openai.com/codex/device",
				instructions: "Enter code: ABCD-EFGH",
				manualCodeInput: false,
			},
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://auth.openai.com/api/accounts/deviceauth/usercode",
			expect.any(Object),
		);
	});

	it("times out pending device-code authorization", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
				const url = String(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return new Response(
						JSON.stringify({
							device_auth_id: "device-auth-id",
							user_code: "ABCD-EFGH",
							interval: "900",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return new Response("", { status: 403 });
				}

				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);

		const loginPromise = openaiCodexOAuthProvider.login({
			onAuth: () => {},
			onPrompt: async () => {
				throw new Error("should not prompt");
			},
			onSelect: async () => "device",
		});

		const rejection = expect(loginPromise).rejects.toThrow("OpenAI Codex device authorization timed out");
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		await rejection;
	});

	it("cancels while device-code polling request is pending", async () => {
		const abortController = new AbortController();
		let tokenRequestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return new Response(
						JSON.stringify({
							device_auth_id: "device-auth-id",
							user_code: "ABCD-EFGH",
							interval: "1",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					tokenRequestSignal = init?.signal ?? undefined;
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
					});
				}

				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);

		const loginPromise = openaiCodexOAuthProvider.login({
			onAuth: () => {},
			onPrompt: async () => {
				throw new Error("should not prompt");
			},
			onSelect: async () => "device",
			signal: abortController.signal,
		});

		await vi.waitFor(() => expect(tokenRequestSignal).toBeDefined());
		abortController.abort();

		await expect(loginPromise).rejects.toThrow("Login cancelled");
		expect(tokenRequestSignal?.aborted).toBe(true);
	});
});
