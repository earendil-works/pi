import { gzipSync } from "node:zlib";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityOAuth } from "../src/auth/oauth/antigravity.ts";
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
	originalDispatcher = getGlobalDispatcher();
	mock = new MockAgent();
	mock.disableNetConnect();
	setGlobalDispatcher(mock);
	// Upstream pi-antigravity #69: SDK native fetch exposed raw gzip without its encoding header.
	vi.stubGlobal("fetch", async () => new Response(gzipSync(JSON.stringify({ access_token: "wrong-transport" }))));
});
afterEach(async () => {
	setGlobalDispatcher(originalDispatcher);
	await mock.close();
	vi.unstubAllGlobals();
});

describe("Antigravity OAuth transport", () => {
	it.each([true, false])(
		"decodes compressed refresh responses and preserves metadata (rotation=%s)",
		async (rotate) => {
			await expect((await fetch("https://oauth2.googleapis.com/token")).json()).rejects.toThrow(SyntaxError);
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
				path: "/oauth2/v1/userinfo?alt=json",
				method: "GET",
				headers: { authorization: "Bearer login-access" },
			})
			.reply(200, gzipSync(JSON.stringify({ email: "user@example.test" })), { headers });
		const nativeFetch = vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith(":loadCodeAssist"))
				return Response.json({ cloudaicompanionProject: "login-project" });
			throw new Error("OAuth must not use native fetch");
		});
		vi.stubGlobal("fetch", nativeFetch);
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
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "auth_url" }));
		expect(nativeFetch).toHaveBeenCalledTimes(1);
		mock.assertNoPendingInterceptors();
	});

	it("aborts before dispatching a refresh", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(antigravityOAuth.refresh(credential, controller.signal)).rejects.toThrow("cancelled");
		expect(mock.pendingInterceptors()).toHaveLength(0);
	});
});
