import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { llmGatewayOAuth } from "../src/auth/oauth/llmgateway.ts";
import { createModels } from "../src/models.ts";
import { llmgatewayProvider } from "../src/providers/llmgateway.ts";

const nativeFetch = globalThis.fetch;

function callbackFromAuthorizeUrl(url: string): { callbackUrl: URL; state: string } {
	const authorizeUrl = new URL(url);
	const callbackUrl = new URL(authorizeUrl.searchParams.get("callback") ?? "");
	const state = authorizeUrl.searchParams.get("state") ?? "";
	return { callbackUrl, state };
}

describe.sequential("LLM Gateway OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is exposed alongside API-key auth", () => {
		const provider = llmgatewayProvider();
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with LLM Gateway");
	});

	it("resolves a stored OAuth key as the API key", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("llmgateway", async () => ({
			type: "oauth",
			access: "llmgtwy-stored",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		}));

		const models = createModels({ credentials });
		models.setProvider(llmgatewayProvider());

		expect((await models.getAuth("llmgateway"))?.auth.apiKey).toBe("llmgtwy-stored");
	});

	it("receives the minted key on a one-shot loopback callback without any outbound request", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("Login must not make outbound requests");
		});
		vi.stubGlobal("fetch", fetchMock);

		let authorizeUrl: URL | undefined;
		let callbackResponse: Promise<Response> | undefined;
		let manualSignal: AbortSignal | undefined;
		const credential = await llmGatewayOAuth.login({
			prompt: (prompt) => {
				manualSignal = prompt.signal;
				return new Promise<string>(() => {});
			},
			notify: (event) => {
				if (event.type !== "auth_url") return;
				authorizeUrl = new URL(event.url);
				const { callbackUrl, state } = callbackFromAuthorizeUrl(event.url);
				callbackUrl.searchParams.set("key", "llmgtwy-test");
				callbackUrl.searchParams.set("state", state);
				callbackResponse = nativeFetch(callbackUrl);
			},
		});

		expect(credential).toEqual({
			type: "oauth",
			access: "llmgtwy-test",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect((await callbackResponse)?.status).toBe(200);
		expect(manualSignal?.aborted).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		expect(authorizeUrl?.origin).toBe("https://llmgateway.io");
		expect(authorizeUrl?.pathname).toBe("/connect/cli");
		expect(authorizeUrl?.searchParams.get("source")).toBe("pi-agent");
		expect(authorizeUrl?.searchParams.get("name")).toBe("Pi coding agent");
		expect(authorizeUrl?.searchParams.get("state")).toBeTruthy();

		const callbackUrl = new URL(authorizeUrl?.searchParams.get("callback") ?? "");
		expect(callbackUrl.hostname).toBe("127.0.0.1");
		expect(callbackUrl.pathname).toMatch(/^\/oauth\/callback\/[0-9a-f-]+$/);
	});

	it("ignores callbacks with a mismatched state", async () => {
		let callbackUrl: URL | undefined;
		let state: string | undefined;
		const login = llmGatewayOAuth.login({
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				({ callbackUrl, state } = callbackFromAuthorizeUrl(event.url));
			},
		});

		await vi.waitFor(() => expect(callbackUrl).toBeDefined());
		const forged = new URL(callbackUrl!);
		forged.searchParams.set("key", "llmgtwy-forged");
		forged.searchParams.set("state", "wrong-state");
		expect((await nativeFetch(forged)).status).toBe(400);

		const genuine = new URL(callbackUrl!);
		genuine.searchParams.set("key", "llmgtwy-genuine");
		genuine.searchParams.set("state", state!);
		expect((await nativeFetch(genuine)).status).toBe(200);

		await expect(login).resolves.toMatchObject({ access: "llmgtwy-genuine" });
	});

	it("fails login when the authorization is denied", async () => {
		let callbackResponse: Promise<Response> | undefined;
		const login = llmGatewayOAuth.login({
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const { callbackUrl, state } = callbackFromAuthorizeUrl(event.url);
				callbackUrl.searchParams.set("error", "access_denied");
				callbackUrl.searchParams.set("error_description", "user denied the request");
				callbackUrl.searchParams.set("state", state);
				callbackResponse = nativeFetch(callbackUrl);
			},
		});

		await expect(login).rejects.toThrow("LLM Gateway authorization failed: user denied the request");
		expect((await callbackResponse)?.status).toBe(400);
	});

	it("ignores an error callback with a mismatched state", async () => {
		let callbackUrl: URL | undefined;
		let state: string | undefined;
		const login = llmGatewayOAuth.login({
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				({ callbackUrl, state } = callbackFromAuthorizeUrl(event.url));
			},
		});

		await vi.waitFor(() => expect(callbackUrl).toBeDefined());
		const forged = new URL(callbackUrl!);
		forged.searchParams.set("error", "access_denied");
		expect((await nativeFetch(forged)).status).toBe(400);

		const genuine = new URL(callbackUrl!);
		genuine.searchParams.set("key", "llmgtwy-after-forged-error");
		genuine.searchParams.set("state", state!);
		expect((await nativeFetch(genuine)).status).toBe(200);

		await expect(login).resolves.toMatchObject({ access: "llmgtwy-after-forged-error" });
	});

	it("keeps waiting when a callback carries no key", async () => {
		let callbackUrl: URL | undefined;
		let state: string | undefined;
		const login = llmGatewayOAuth.login({
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				({ callbackUrl, state } = callbackFromAuthorizeUrl(event.url));
			},
		});

		await vi.waitFor(() => expect(callbackUrl).toBeDefined());
		const empty = new URL(callbackUrl!);
		empty.searchParams.set("state", state!);
		expect((await nativeFetch(empty)).status).toBe(400);

		const complete = new URL(callbackUrl!);
		complete.searchParams.set("key", "llmgtwy-late");
		complete.searchParams.set("state", state!);
		expect((await nativeFetch(complete)).status).toBe(200);

		await expect(login).resolves.toMatchObject({ access: "llmgtwy-late" });
	});

	it("allows only one callback to complete the login", async () => {
		let callbackUrl: URL | undefined;
		let state: string | undefined;
		const login = llmGatewayOAuth.login({
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				({ callbackUrl, state } = callbackFromAuthorizeUrl(event.url));
			},
		});

		await vi.waitFor(() => expect(callbackUrl).toBeDefined());
		const first = new URL(callbackUrl!);
		first.searchParams.set("key", "llmgtwy-first");
		first.searchParams.set("state", state!);
		expect((await nativeFetch(first)).status).toBe(200);

		await expect(login).resolves.toMatchObject({ access: "llmgtwy-first" });
	});

	it("accepts a pasted redirect URL when the loopback callback never arrives", async () => {
		let callbackUrl: string | undefined;
		let state: string | undefined;
		const credential = await llmGatewayOAuth.login({
			prompt: async (prompt) => {
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return `${callbackUrl}?key=llmgtwy-manual&state=${state}`;
			},
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const authorizeUrl = new URL(event.url);
				callbackUrl = authorizeUrl.searchParams.get("callback") ?? undefined;
				state = authorizeUrl.searchParams.get("state") ?? undefined;
			},
		});

		expect(credential).toEqual({
			type: "oauth",
			access: "llmgtwy-manual",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		});
	});

	it("accepts a bare API key from the manual prompt", async () => {
		const credential = await llmGatewayOAuth.login({
			prompt: async () => "  llmgtwy-bare  ",
			notify: () => {},
		});

		expect(credential).toMatchObject({ access: "llmgtwy-bare" });
	});

	it("rejects a pasted redirect URL with a mismatched state", async () => {
		let callbackUrl: string | undefined;
		const login = llmGatewayOAuth.login({
			prompt: async (prompt) => {
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return `${callbackUrl}?key=llmgtwy-forged&state=wrong-state`;
			},
			notify: (event) => {
				if (event.type !== "auth_url") return;
				callbackUrl = new URL(event.url).searchParams.get("callback") ?? undefined;
			},
		});

		await expect(login).rejects.toThrow("State mismatch in pasted callback URL");
	});

	it("fails login when the manual prompt is cancelled", async () => {
		await expect(
			llmGatewayOAuth.login({
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("rejects empty manual input", async () => {
		await expect(
			llmGatewayOAuth.login({
				prompt: async () => "   ",
				notify: () => {},
			}),
		).rejects.toThrow("Missing API key");
	});

	it("closes the pending callback when login is cancelled", async () => {
		const controller = new AbortController();
		let callbackUrl: URL | undefined;
		const login = llmGatewayOAuth.login({
			signal: controller.signal,
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				({ callbackUrl } = callbackFromAuthorizeUrl(event.url));
				controller.abort();
			},
		});

		await expect(login).rejects.toThrow("Login cancelled");
		expect(callbackUrl).toBeDefined();
		await expect(nativeFetch(callbackUrl!)).rejects.toThrow();
	});

	it("rejects before opening a callback server when login is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			llmGatewayOAuth.login({
				signal: controller.signal,
				prompt: async () => "",
				notify: () => {
					throw new Error("Cancelled login must not emit events");
				},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("uses the configured OAuth callback host", async () => {
		vi.stubEnv("PI_OAUTH_CALLBACK_HOST", "localhost");
		const controller = new AbortController();
		let callbackUrl: URL | undefined;
		const login = llmGatewayOAuth.login({
			signal: controller.signal,
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				({ callbackUrl } = callbackFromAuthorizeUrl(event.url));
				controller.abort();
			},
		});

		await expect(login).rejects.toThrow("Login cancelled");
		expect(callbackUrl?.hostname).toBe("localhost");
	});
});
