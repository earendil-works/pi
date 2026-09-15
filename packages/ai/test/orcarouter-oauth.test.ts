import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import {
	assertSecureOrigin,
	ORCAROUTER_DEFAULT_AUTH_BASE_URL,
	orcaRouterOAuth,
	resolveOrcaRouterAuthBaseUrl,
} from "../src/auth/oauth/orcarouter.ts";
import { isNeedsReauth, markCredentialRejected } from "../src/auth/reauth.ts";
import { createModels } from "../src/models.ts";
import { ORCAROUTER_FALLBACK_MODELS } from "../src/orcarouter/catalog.ts";
import { orcaRouterProvider } from "../src/providers/orcarouter.ts";

const EXCHANGE_URL = "https://www.orcarouter.ai/api/v1/auth/keys";
const nativeFetch = globalThis.fetch;
const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Drive one login to completion through the adapter, returning what it observed. */
async function runLogin(
	options: {
		respond?: (init?: RequestInit) => Response | Promise<Response>;
		/** Mutate the callback query before it reaches the loopback server. */
		tamper?: (callbackUrl: URL) => void;
	} = {},
) {
	const exchangeCalls: { url: string; body: Record<string, unknown> }[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith("https://www.orcarouter.ai")) return nativeFetch(input, init);
		exchangeCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		return options.respond ? options.respond(init) : jsonResponse({ key: "sk-orca-test-key", scope: "api" });
	});
	vi.stubGlobal("fetch", fetchMock);

	let authorizeUrl: URL | undefined;
	let callbackResponse: Promise<Response> | undefined;
	let manualSignal: AbortSignal | undefined;
	const logs: string[] = [];
	const login = orcaRouterOAuth.login({
		signal: neverAbortedSignal,
		prompt: (prompt) => {
			manualSignal = prompt.signal;
			return new Promise<string>(() => {});
		},
		notify: (event) => {
			logs.push(JSON.stringify(event));
			if (event.type !== "auth_url") return;
			authorizeUrl = new URL(event.url);
			const callbackUrl = new URL(authorizeUrl.searchParams.get("callback_url") ?? "");
			callbackUrl.searchParams.set("code", "one-time-code");
			// Echo the state the client sent, exactly as the consent screen does.
			callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
			options.tamper?.(callbackUrl);
			callbackResponse = nativeFetch(callbackUrl);
		},
	});

	return {
		login,
		exchangeCalls,
		authorizeUrl: () => authorizeUrl,
		callbackResponse: () => callbackResponse,
		manualSignal: () => manualSignal,
		logs,
	};
}

describe.sequential("OrcaRouter OAuth (PKCE)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is exposed by the OrcaRouter provider alongside API-key auth", () => {
		const provider = orcaRouterProvider();
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with OrcaRouter");
		expect(provider.auth.apiKey?.name).toBe("OrcaRouter API key");
	});

	it("returns the same credential result from the PKCE adapter as the API-key adapter", async () => {
		// The credential seam must be source-agnostic: inference and model
		// discovery must not care which adapter produced the key.
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.startsWith("https://www.orcarouter.ai")) return nativeFetch(input, init);
			return jsonResponse({ key: "sk-orca-from-pkce", user_id: "1", scope: "api" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const pkceCredentials = new InMemoryCredentialStore();
		const pkce = await orcaRouterOAuth.login({
			signal: neverAbortedSignal,
			prompt: async (prompt) => (prompt.type === "manual_code" ? "pkce-code" : ""),
			notify: () => {},
		});
		await pkceCredentials.modify("orcarouter", async () => pkce);
		const pkceModels = createModels({ credentials: pkceCredentials });
		pkceModels.setProvider(orcaRouterProvider());

		// Adapter 1: paste an existing key.
		const apiKeyCredentials = new InMemoryCredentialStore();
		const apiKeyProvider = orcaRouterProvider();
		const apiKeyCredential = await apiKeyProvider.auth.apiKey?.login?.({
			signal: neverAbortedSignal,
			prompt: async () => "sk-orca-pasted-key",
			notify: () => {},
		});
		await apiKeyCredentials.modify("orcarouter", async () => apiKeyCredential);
		const apiKeyModels = createModels({ credentials: apiKeyCredentials });
		apiKeyModels.setProvider(orcaRouterProvider());

		const viaPkce = await pkceModels.getAuth("orcarouter");
		const viaApiKey = await apiKeyModels.getAuth("orcarouter");

		// Both adapters produce the same request-auth shape: one bearer key.
		expect(viaPkce?.auth).toEqual({ apiKey: "sk-orca-from-pkce" });
		expect(viaApiKey?.auth).toEqual({ apiKey: "sk-orca-pasted-key" });
		expect(viaPkce?.auth.apiKey).toMatch(/^sk-orca-/);
		// Downstream model discovery sees only "is there a key", not its source.
		expect(pkceModels.getModels("orcarouter").length).toBe(apiKeyModels.getModels("orcarouter").length);
	});

	it("sends authorize and exchange requests to the auth origin, never the inference origin", async () => {
		const run = await runLogin();
		await expect(run.login).resolves.toMatchObject({ access: "sk-orca-test-key" });

		expect(run.authorizeUrl()?.origin).toBe(ORCAROUTER_DEFAULT_AUTH_BASE_URL);
		expect(run.authorizeUrl()?.pathname).toBe("/auth");
		// The documented mistake: /v1/auth/keys on the inference origin is a 404.
		expect(run.exchangeCalls[0]?.url).toBe(EXCHANGE_URL);
		expect(run.exchangeCalls[0]?.url).not.toContain("api.orcarouter.ai");
		// The documented mistake is `https://api.orcarouter.ai/v1/auth/keys`.
		expect(run.exchangeCalls[0]?.url.startsWith("https://www.orcarouter.ai/api/v1/auth/keys")).toBe(true);
	});

	it("sends only an S256 challenge, with a fresh verifier and state per attempt", async () => {
		const first = await runLogin();
		await expect(first.login).resolves.toBeTruthy();
		const second = await runLogin();
		await expect(second.login).resolves.toBeTruthy();

		const verifiers = [first, second].map((run) => String(run.exchangeCalls[0]?.body.code_verifier));
		const states = [first, second].map((run) => run.authorizeUrl()?.searchParams.get("state"));
		const challenges = [first, second].map((run) => run.authorizeUrl()?.searchParams.get("code_challenge"));

		// Fresh cryptographic randomness for every attempt, never reused.
		expect(verifiers[0]).not.toBe(verifiers[1]);
		expect(states[0]).not.toBe(states[1]);
		expect(challenges[0]).not.toBe(challenges[1]);
		expect(verifiers[0]?.length).toBeGreaterThanOrEqual(43);
		expect(states[0]).toMatch(/^[0-9a-f-]{36}$/);

		for (const [index, run] of [first, second].entries()) {
			expect(run.authorizeUrl()?.searchParams.get("code_challenge_method")).toBe("S256");
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifiers[index])));
			expect(run.authorizeUrl()?.searchParams.get("code_challenge")).toBe(base64url(new Uint8Array(digest)));
			// The exchange echoes the same method, so a downgrade is detectable.
			expect(run.exchangeCalls[0]?.body.code_challenge_method).toBe("S256");
			expect(run.authorizeUrl()?.searchParams.get("app_name")).toBe("pi");
			expect(run.authorizeUrl()?.searchParams.get("scope")).toBe("api");
		}
	});

	it("keeps the verifier out of URLs, logs, and error messages", async () => {
		const serverBodyMarker = "ServerBodyMarker-9f3a";
		const run = await runLogin({
			respond: () =>
				jsonResponse({ error: "invalid_grant", error_description: `code already used ${serverBodyMarker}` }, 403),
		});
		await expect(run.login).rejects.toThrow(/HTTP 403/);

		const verifier = String(run.exchangeCalls[0]?.body.code_verifier);
		expect(verifier.length).toBeGreaterThan(0);
		const authorizeUrl = run.authorizeUrl()?.toString() ?? "";
		expect(authorizeUrl).not.toContain(verifier);
		expect(run.logs.join("\n")).not.toContain(verifier);

		// The rejected response body is never echoed into the error the user sees:
		// a body can reflect request material. Only a fixed status message is used.
		const message = await run.login.catch((error: Error) => error.message);
		expect(message).not.toContain(serverBodyMarker);
		expect(message).toContain("HTTP 403");
	});

	it("serves the loopback callback and reports denial without hanging", async () => {
		const run = await runLogin({
			respond: () => jsonResponse({ error: "access_denied" }, 403),
			tamper: (callbackUrl) => {
				callbackUrl.searchParams.delete("code");
				callbackUrl.searchParams.set("error", "access_denied");
			},
		});
		await expect(run.login).rejects.toThrow(/authorization failed: access_denied/);
		expect((await run.callbackResponse())?.status).toBe(400);
		expect(run.exchangeCalls).toHaveLength(0);
	});

	it("rejects a callback whose state does not match", async () => {
		const run = await runLogin({
			tamper: (callbackUrl) => callbackUrl.searchParams.set("state", "attacker-state"),
		});
		await expect(run.login).rejects.toThrow(/state mismatch/);
		expect((await run.callbackResponse())?.status).toBe(400);
		// A mismatched state must never reach the exchange.
		expect(run.exchangeCalls).toHaveLength(0);
	});

	it("fails closed when the granted scope is narrower than the requested scope", async () => {
		const run = await runLogin({
			respond: () => jsonResponse({ key: "sk-orca-narrow", user_id: "1", scope: "connector" }),
		});
		await expect(run.login).rejects.toThrow(/granted scope "connector"/);
	});

	it("reports a replayed or expired code as an actionable 403", async () => {
		const run = await runLogin({ respond: () => jsonResponse({ error: "invalid_grant" }, 403) });
		await expect(run.login).rejects.toThrow(/already used|does not match this device/);
	});

	it("reports a 400 challenge-method mismatch distinctly", async () => {
		const run = await runLogin({ respond: () => jsonResponse({ error: "invalid_request" }, 400) });
		await expect(run.login).rejects.toThrow(/challenge method was refused/);
	});

	it("reports 429 with the key-issuance cap instead of hot-looping", async () => {
		const run = await runLogin({ respond: () => jsonResponse({ error: "rate_limited" }, 429) });
		await expect(run.login).rejects.toThrow(/10 keys per 24 hours/);
		expect(run.exchangeCalls).toHaveLength(1);
	});

	it("surfaces a network failure without retrying forever", async () => {
		const run = await runLogin({
			respond: () => {
				throw new Error("socket hang up");
			},
		});
		await expect(run.login).rejects.toThrow(/socket hang up/);
		expect(run.exchangeCalls).toHaveLength(1);
	});

	it("cancels a pending login on abort and releases the login lock", async () => {
		const controller = new AbortController();
		const login = orcaRouterOAuth.login({
			signal: controller.signal,
			prompt: () => new Promise<string>(() => {}),
			notify: () => {},
		});
		controller.abort();
		await expect(login).rejects.toThrow(/cancelled/);

		// A second login must be able to start afterwards.
		const run = await runLogin();
		await expect(run.login).resolves.toMatchObject({ access: "sk-orca-test-key" });
	});

	it("uses the shared self-hosted base and lets explicit overrides win", () => {
		vi.stubEnv("ORCA_BASE_URL", "https://gateway.internal.example");
		expect(resolveOrcaRouterAuthBaseUrl()).toBe("https://gateway.internal.example");
		vi.stubEnv("ORCA_AUTH_BASE_URL", "https://auth.internal.example");
		expect(resolveOrcaRouterAuthBaseUrl()).toBe("https://auth.internal.example");
		vi.unstubAllEnvs();
		expect(resolveOrcaRouterAuthBaseUrl()).toBe(ORCAROUTER_DEFAULT_AUTH_BASE_URL);
	});

	it("requires HTTPS for remote origins but allows loopback HTTP", () => {
		expect(assertSecureOrigin("https://www.orcarouter.ai", "auth").origin).toBe("https://www.orcarouter.ai");
		expect(assertSecureOrigin("http://127.0.0.1:8080", "auth").port).toBe("8080");
		expect(assertSecureOrigin("http://localhost:8080", "auth").hostname).toBe("localhost");
		expect(() => assertSecureOrigin("http://evil.example", "auth")).toThrow(/must use HTTPS/);
	});

	it("keeps both auth methods independently usable", async () => {
		// API-key users must not be forced through a browser, and PKCE users must
		// not need a pre-existing key.
		const provider = orcaRouterProvider();
		const apiKeyCredential = await provider.auth.apiKey?.login?.({
			signal: neverAbortedSignal,
			prompt: async (prompt) => {
				expect(prompt.type).toBe("secret");
				return "sk-orca-key-only";
			},
			notify: () => {},
		});
		expect(apiKeyCredential).toEqual({ type: "api_key", key: "sk-orca-key-only" });
		expect(provider.auth.oauth?.login).toBeTypeOf("function");
		expect(provider.auth.oauth?.toAuth).toBeTypeOf("function");
	});
});

describe.sequential("OrcaRouter durable-credential lifecycle", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("reuses the stored key and never performs a fake refresh", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("orcarouter", async () => ({
			type: "oauth",
			access: "sk-orca-durable",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		const models = createModels({ credentials });
		models.setProvider(orcaRouterProvider());

		for (let i = 0; i < 3; i++) {
			expect((await models.getAuth("orcarouter"))?.auth.apiKey).toBe("sk-orca-durable");
		}
		// The stored credential is untouched: no rotation was invented.
		await expect(credentials.read("orcarouter")).resolves.toMatchObject({ refresh: "" });
	});

	it("marks a revoked credential as needing reauthentication without deleting it", async () => {
		const credentials = new InMemoryCredentialStore();
		const revoked = {
			type: "oauth" as const,
			access: "sk-orca-revoked",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		};
		await credentials.modify("orcarouter", async () => revoked);

		await markCredentialRejected(credentials, "orcarouter", revoked, { signal: neverAbortedSignal });

		const stored = await credentials.read("orcarouter");
		expect(isNeedsReauth(stored)).toBe(true);
		// Kept, not deleted: a misclassified failure must stay recoverable.
		expect(stored).toMatchObject({ access: "sk-orca-revoked" });

		// A needsReauth credential is unusable and does not fall back to env.
		vi.stubEnv("ORCAROUTER_API_KEY", "sk-orca-ambient");
		const models = createModels({ credentials });
		models.setProvider(orcaRouterProvider());
		expect(await models.getAuth("orcarouter")).toBeUndefined();
	});

	it("does not let a late 401 from an old generation poison a fresh login", async () => {
		const credentials = new InMemoryCredentialStore();
		const oldCredential = {
			type: "oauth" as const,
			access: "sk-orca-old-generation",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		};
		await credentials.modify("orcarouter", async () => oldCredential);

		// A newer login replaces the credential before the old request's 401 lands.
		const newCredential = {
			type: "oauth" as const,
			access: "sk-orca-new-generation",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		};
		await credentials.modify("orcarouter", async () => newCredential);

		await markCredentialRejected(credentials, "orcarouter", oldCredential, { signal: neverAbortedSignal });

		const stored = await credentials.read("orcarouter");
		expect(isNeedsReauth(stored)).toBe(false);
		expect(stored).toMatchObject({ access: "sk-orca-new-generation" });

		const models = createModels({ credentials });
		models.setProvider(orcaRouterProvider());
		expect((await models.getAuth("orcarouter"))?.auth.apiKey).toBe("sk-orca-new-generation");
	});

	it("marks only the rejected provider, leaving other providers usable", async () => {
		const credentials = new InMemoryCredentialStore();
		const orcaCredential = {
			type: "oauth" as const,
			access: "sk-orca-x",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		};
		await credentials.modify("orcarouter", async () => orcaCredential);
		await credentials.modify("openrouter", async () => ({
			type: "oauth",
			access: "sk-or-untouched",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		}));

		await markCredentialRejected(credentials, "orcarouter", orcaCredential, { signal: neverAbortedSignal });

		expect(isNeedsReauth(await credentials.read("orcarouter"))).toBe(true);
		expect(isNeedsReauth(await credentials.read("openrouter"))).toBe(false);
	});

	it("keeps the API-key credential shape usable for a pasted key", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("orcarouter", async () => ({ type: "api_key", key: "sk-orca-pasted" }));
		const models = createModels({ credentials });
		models.setProvider(orcaRouterProvider());
		expect((await models.getAuth("orcarouter"))?.auth.apiKey).toBe("sk-orca-pasted");
		// Both choices remain registered regardless of which one was used.
		expect(orcaRouterProvider().auth.oauth).toBeDefined();
		expect(orcaRouterProvider().auth.apiKey).toBeDefined();
	});

	it("keeps a verified seed entry's reasoning ladder and modalities out of the Ids-only trap", () => {
		const seed = ORCAROUTER_FALLBACK_MODELS.find((model) => model.id === "openai/gpt-5.5");
		expect(seed).toBeDefined();
		expect(seed?.reasoning).toBe(true);
		expect(seed?.inputModalities).toContain("image");

		const model = orcaRouterProvider()
			.getModels()
			.find((entry) => entry.id === "openai/gpt-5.5");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.thinkingLevelMap).toMatchObject({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
	});
});
