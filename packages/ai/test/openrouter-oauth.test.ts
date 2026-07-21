import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { createImagesModels } from "../src/images-models.ts";
import { createModels } from "../src/models.ts";
import { openrouterProvider } from "../src/providers/openrouter.ts";
import { openrouterImagesProvider } from "../src/providers/openrouter-images.ts";

const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe.sequential("OpenRouter OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is exposed by both OpenRouter providers alongside API-key auth", () => {
		for (const provider of [openrouterProvider(), openrouterImagesProvider()]) {
			expect(provider.auth.apiKey).toBeDefined();
			expect(provider.auth.oauth).toBeDefined();
			expect(provider.auth.oauth?.loginLabel).toBe("Sign in with OpenRouter");
		}
	});

	it("resolves the same stored OAuth key for text and image providers", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openrouter", async () => ({
			type: "oauth",
			access: "sk-or-stored",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		}));

		const textModels = createModels({ credentials });
		textModels.setProvider(openrouterProvider());
		const imageModels = createImagesModels({ credentials });
		imageModels.setProvider(openrouterImagesProvider());

		expect((await textModels.getAuth("openrouter"))?.auth.apiKey).toBe("sk-or-stored");
		expect((await imageModels.getAuth("openrouter"))?.auth.apiKey).toBe("sk-or-stored");
	});

	it("runs PKCE on a one-shot loopback callback and exchanges the code for a permanent API key", async () => {
		let exchangeBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== TOKEN_URL) return nativeFetch(input, init);
			exchangeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ key: "sk-or-test" });
		});
		vi.stubGlobal("fetch", fetchMock);

		let authorizeUrl: URL | undefined;
		let callbackResponse: Promise<Response> | undefined;
		const credential = await openRouterOAuth.login({
			prompt: async () => {
				throw new Error("OpenRouter login must not prompt for a code");
			},
			notify: (event) => {
				if (event.type !== "auth_url") return;
				authorizeUrl = new URL(event.url);
				const callbackUrl = new URL(authorizeUrl.searchParams.get("callback_url") ?? "");
				callbackUrl.searchParams.set("code", "authorization-code");
				callbackResponse = nativeFetch(callbackUrl);
			},
		});

		expect(credential).toEqual({
			type: "oauth",
			access: "sk-or-test",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect((await callbackResponse)?.status).toBe(200);
		expect(authorizeUrl?.origin).toBe("https://openrouter.ai");
		expect(authorizeUrl?.pathname).toBe("/auth");
		expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");

		const callbackUrl = new URL(authorizeUrl?.searchParams.get("callback_url") ?? "");
		expect(callbackUrl.hostname).toBe("127.0.0.1");
		expect(callbackUrl.pathname).toMatch(/^\/oauth\/callback\/[0-9a-f-]+$/);

		expect(exchangeBody).toMatchObject({
			code: "authorization-code",
			code_challenge_method: "S256",
		});
		const verifier = exchangeBody?.code_verifier;
		expect(typeof verifier).toBe("string");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier)));
		expect(authorizeUrl?.searchParams.get("code_challenge")).toBe(base64url(new Uint8Array(digest)));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports token exchange failures through both the callback page and login", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: { message: "invalid code" } }, 403)),
		);

		let callbackResponse: Promise<Response> | undefined;
		const login = openRouterOAuth.login({
			prompt: async () => "",
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const callbackUrl = new URL(new URL(event.url).searchParams.get("callback_url") ?? "");
				callbackUrl.searchParams.set("code", "bad-code");
				callbackResponse = nativeFetch(callbackUrl);
			},
		});

		await expect(login).rejects.toThrow("OpenRouter OAuth key exchange failed (HTTP 403): invalid code");
		expect((await callbackResponse)?.status).toBe(502);
	});

	it("allows only one token exchange for a callback", async () => {
		let completeExchange = (_response: Response): void => {
			throw new Error("Token exchange did not start");
		};
		const fetchMock = vi.fn(
			async () =>
				new Promise<Response>((resolve) => {
					completeExchange = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		let callbackUrl: URL | undefined;
		let firstCallback: Promise<Response> | undefined;
		const login = openRouterOAuth.login({
			prompt: async () => "",
			notify: (event) => {
				if (event.type !== "auth_url") return;
				callbackUrl = new URL(new URL(event.url).searchParams.get("callback_url") ?? "");
				callbackUrl.searchParams.set("code", "authorization-code");
				firstCallback = nativeFetch(callbackUrl);
			},
		});

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		if (!callbackUrl) throw new Error("OpenRouter did not provide a callback URL");
		expect((await nativeFetch(callbackUrl)).status).toBe(409);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		completeExchange(jsonResponse({ key: "sk-or-test" }));

		await expect(login).resolves.toMatchObject({ access: "sk-or-test" });
		expect((await firstCallback)?.status).toBe(200);
	});

	it("rejects a successful response that does not contain a key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ user_id: "user-1" })),
		);

		let callbackResponse: Promise<Response> | undefined;
		const login = openRouterOAuth.login({
			prompt: async () => "",
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const callbackUrl = new URL(new URL(event.url).searchParams.get("callback_url") ?? "");
				callbackUrl.searchParams.set("code", "code-without-key");
				callbackResponse = nativeFetch(callbackUrl);
			},
		});

		await expect(login).rejects.toThrow('OpenRouter OAuth response carries no "key"');
		expect((await callbackResponse)?.status).toBe(502);
	});

	it("closes the pending callback when login is cancelled", async () => {
		const controller = new AbortController();
		let callbackUrl: URL | undefined;
		const login = openRouterOAuth.login({
			signal: controller.signal,
			prompt: async () => "",
			notify: (event) => {
				if (event.type !== "auth_url") return;
				callbackUrl = new URL(new URL(event.url).searchParams.get("callback_url") ?? "");
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
			openRouterOAuth.login({
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
		const login = openRouterOAuth.login({
			signal: controller.signal,
			prompt: async () => "",
			notify: (event) => {
				if (event.type !== "auth_url") return;
				callbackUrl = new URL(new URL(event.url).searchParams.get("callback_url") ?? "");
				controller.abort();
			},
		});

		await expect(login).rejects.toThrow("Login cancelled");
		expect(callbackUrl?.hostname).toBe("localhost");
	});
});
