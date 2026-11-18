import { gzipSync } from "node:zlib";
import { getGlobalDispatcher, install, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityOAuth } from "../src/auth/oauth/antigravity.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "../src/auth/oauth/callback-server.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

vi.mock("../src/auth/oauth/callback-server.ts", () => ({
	startOAuthCallbackServer: vi.fn(async () => ({ close: vi.fn() })),
	waitForCallbackOrManualInput: vi.fn(async () => ({ type: "callback", value: "fake-code" })),
}));

const credential: OAuthCredential = {
	type: "oauth",
	access: "old-access",
	refresh: "fake-refresh",
	expires: 0,
	projectId: "fake-project",
	email: "user@example.test",
};
const headers = { "content-type": "application/json", "content-encoding": "gzip" };
let mock: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
	install();
	originalDispatcher = getGlobalDispatcher();
	mock = new MockAgent();
	mock.disableNetConnect();
	setGlobalDispatcher(mock);
});
afterEach(async () => {
	setGlobalDispatcher(originalDispatcher);
	await mock.close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Antigravity OAuth transport", () => {
	it.each([true, false])(
		"decodes compressed refresh responses and preserves metadata (rotation=%s)",
		async (rotate) => {
			mock
				.get("https://oauth2.googleapis.com")
				.intercept({ path: "/token", method: "POST", body: /refresh_token=fake-refresh/ })
				.reply(
					200,
					gzipSync(
						JSON.stringify({
							access_token: "new-access",
							expires_in: 3600,
							...(rotate ? { refresh_token: "new-refresh" } : {}),
						}),
					),
					{ headers },
				);
			const result = await antigravityOAuth.refresh(credential, new AbortController().signal);
			expect(result).toMatchObject({
				access: "new-access",
				refresh: rotate ? "new-refresh" : "fake-refresh",
				projectId: credential.projectId,
				email: credential.email,
			});
			expect(result.expires).toBeGreaterThan(Date.now());
			mock.assertNoPendingInterceptors();
		},
	);

	it("decodes compressed provider errors through the shared dispatcher", async () => {
		mock
			.get("https://oauth2.googleapis.com")
			.intercept({ path: "/token", method: "POST" })
			.reply(400, gzipSync(JSON.stringify({ error: "invalid_grant" })), { headers });
		await expect(antigravityOAuth.refresh(credential, new AbortController().signal)).rejects.toThrow(
			/400.*invalid_grant/,
		);
		mock.assertNoPendingInterceptors();
	});

	it("uses the same transport for login token exchange and user info", async () => {
		mock
			.get("https://oauth2.googleapis.com")
			.intercept({ path: "/token", method: "POST", body: /grant_type=authorization_code/ })
			.reply(
				200,
				gzipSync(
					JSON.stringify({ access_token: "login-access", refresh_token: "login-refresh", expires_in: 3600 }),
				),
				{ headers },
			);
		mock
			.get("https://www.googleapis.com")
			.intercept({
				path: "/oauth2/v2/userinfo?alt=json",
				method: "GET",
				headers: { authorization: "Bearer login-access" },
			})
			.reply(200, gzipSync(JSON.stringify({ email: "user@example.test" })), { headers });
		mock
			.get("https://daily-cloudcode-pa.googleapis.com")
			.intercept({ path: "/v1internal:loadCodeAssist", method: "POST" })
			.reply(200, gzipSync(JSON.stringify({ cloudaicompanionProject: "login-project" })), { headers });
		const notify = vi.fn();
		const result = await antigravityOAuth.login({
			signal: new AbortController().signal,
			notify,
			prompt: async () => "unused",
		});
		expect(result).toMatchObject({
			access: "login-access",
			refresh: "login-refresh",
			email: "user@example.test",
			projectId: "login-project",
		});
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "auth_url",
				url: expect.stringContaining("redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback"),
			}),
		);
		const authUrl = notify.mock.calls[0][0].url as string;
		expect(authUrl).toContain("scope=");
		expect(authUrl).toContain("openid");
		expect(authUrl).toContain("auth%2Faicode");
		mock.assertNoPendingInterceptors();
	});

	it("mints a persistent negative-int64 session id from the device id and keeps it across refresh", async () => {
		mock
			.get("https://oauth2.googleapis.com")
			.intercept({ path: "/token", method: "POST", body: /grant_type=authorization_code/ })
			.reply(200, gzipSync(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 })), {
				headers,
			})
			.persist();
		mock
			.get("https://www.googleapis.com")
			.intercept({ path: "/oauth2/v2/userinfo?alt=json", method: "GET" })
			.reply(200, gzipSync(JSON.stringify({ email: "user@example.test" })), { headers })
			.persist();
		mock
			.get("https://daily-cloudcode-pa.googleapis.com")
			.intercept({ path: "/v1internal:loadCodeAssist", method: "POST" })
			.reply(200, gzipSync(JSON.stringify({ cloudaicompanionProject: "p" })), { headers })
			.persist();
		const interaction = { signal: new AbortController().signal, notify: vi.fn(), prompt: async () => "unused" };
		const first = await antigravityOAuth.login(interaction, { getDeviceId: () => "device-123" });
		const again = await antigravityOAuth.login(interaction, { getDeviceId: () => "device-123" });
		const other = await antigravityOAuth.login(interaction, { getDeviceId: () => "device-456" });
		expect(first.antigravitySessionId).toMatch(/^-\d{1,19}$/);
		expect(again.antigravitySessionId).toBe(first.antigravitySessionId);
		expect(other.antigravitySessionId).not.toBe(first.antigravitySessionId);

		mock
			.get("https://oauth2.googleapis.com")
			.intercept({ path: "/token", method: "POST", body: /refresh_token=r/ })
			.reply(200, gzipSync(JSON.stringify({ access_token: "b", expires_in: 3600 })), { headers });
		const refreshed = await antigravityOAuth.refresh(first, new AbortController().signal);
		expect(refreshed.antigravitySessionId).toBe(first.antigravitySessionId);

		const auth = await antigravityOAuth.toAuth(refreshed);
		expect(JSON.parse(auth.apiKey!)).toEqual({
			token: "b",
			projectId: "p",
			sessionId: first.antigravitySessionId,
		});
		// A credential minted before the field existed carries no session id.
		expect(JSON.parse((await antigravityOAuth.toAuth(credential)).apiKey!)).toEqual({
			token: "old-access",
			projectId: "fake-project",
		});
		mock.assertNoPendingInterceptors();
	});

	it("aborts before dispatching a refresh", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(antigravityOAuth.refresh(credential, controller.signal)).rejects.toThrow("cancelled");
		expect(mock.pendingInterceptors()).toHaveLength(0);
	});

	it("respects PI_OAUTH_CALLBACK_HOST and falls back to manual callback paste when port 51121 is busy", async () => {
		vi.stubEnv("PI_OAUTH_CALLBACK_HOST", "0.0.0.0");
		vi.mocked(startOAuthCallbackServer).mockRejectedValueOnce(new Error("EADDRINUSE"));
		let notifiedUrl = "";
		vi.mocked(waitForCallbackOrManualInput).mockImplementationOnce(async (_interaction, callback) => {
			expect(callback).toBeUndefined();
			expect(notifiedUrl).toContain("redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback");
			return {
				type: "manual",
				input: "manual-code-from-hosted-page",
			};
		});
		mock
			.get("https://oauth2.googleapis.com")
			.intercept({ path: "/token", method: "POST", body: /code=manual-code-from-hosted-page/ })
			.reply(
				200,
				gzipSync(
					JSON.stringify({ access_token: "manual-access", refresh_token: "manual-refresh", expires_in: 3600 }),
				),
				{ headers },
			);
		mock
			.get("https://www.googleapis.com")
			.intercept({ path: "/oauth2/v2/userinfo?alt=json", method: "GET" })
			.reply(200, gzipSync(JSON.stringify({ email: "user@example.test" })), { headers });
		mock
			.get("https://daily-cloudcode-pa.googleapis.com")
			.intercept({ path: "/v1internal:loadCodeAssist", method: "POST" })
			.reply(200, gzipSync(JSON.stringify({ cloudaicompanionProject: "manual-project" })), { headers });
		const result = await antigravityOAuth.login({
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") notifiedUrl = event.url;
			},
			prompt: async () => "unused",
		});
		expect(startOAuthCallbackServer).toHaveBeenCalledWith(expect.objectContaining({ host: "0.0.0.0", port: 51121 }));
		expect(result).toMatchObject({
			access: "manual-access",
			refresh: "manual-refresh",
			projectId: "manual-project",
		});
		mock.assertNoPendingInterceptors();
	});
});
