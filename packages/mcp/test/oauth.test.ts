import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, StreamableHttpTransport } from "../src/index.ts";
import {
	adaptOAuthProvider,
	authorizeMcp,
	discoverAuthorizationServerMetadata,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	MemoryOAuthStateStore,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthClientInformationMixed,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	OAuthIssuerMismatchError,
	type OAuthTokens,
} from "../src/oauth/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

class TestOAuthProvider implements OAuthClientProvider {
	readonly redirectUrl: string;
	readonly clientMetadata;
	client: OAuthClientInformationMixed | undefined;
	tokenSet: OAuthTokens | undefined;
	verifier: string | undefined;
	discovery: OAuthDiscoveryState | undefined;
	authorizationUrl: URL | undefined;

	constructor(redirectUrl: string) {
		this.redirectUrl = redirectUrl;
		this.clientMetadata = {
			redirect_uris: [redirectUrl],
			client_name: "pi-mcp-test",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		return "expected-state";
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.client;
	}

	saveClientInformation(information: OAuthClientInformationMixed): void {
		this.client = information;
	}

	tokens(): OAuthTokens | undefined {
		return this.tokenSet;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.tokenSet = tokens;
	}

	redirectToAuthorization(url: URL): void {
		this.authorizationUrl = url;
	}

	saveCodeVerifier(verifier: string): void {
		this.verifier = verifier;
	}

	codeVerifier(): string {
		if (!this.verifier) throw new Error("Missing code verifier");
		return this.verifier;
	}

	invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (kind === "all" || kind === "client") this.client = undefined;
		if (kind === "all" || kind === "tokens") this.tokenSet = undefined;
		if (kind === "all" || kind === "verifier") this.verifier = undefined;
		if (kind === "all" || kind === "discovery") this.discovery = undefined;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.discovery = state;
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.discovery;
	}
}

afterEach(closeServers);

describe("MCP OAuth", () => {
	it("discovers, registers, authorizes with PKCE, and refreshes on 401", async () => {
		let expectedChallenge: string | undefined;
		let refreshes = 0;
		const origin = await listen(async (request, response, serverOrigin) => {
			const url = new URL(request.url ?? "/", serverOrigin);
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						resource: `${serverOrigin}/mcp`,
						authorization_servers: [serverOrigin],
						scopes_supported: ["org:read"],
					}),
				);
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						issuer: serverOrigin,
						authorization_endpoint: `${serverOrigin}/authorize`,
						token_endpoint: `${serverOrigin}/token`,
						registration_endpoint: `${serverOrigin}/register`,
						response_types_supported: ["code"],
						grant_types_supported: ["authorization_code", "refresh_token"],
						token_endpoint_auth_methods_supported: ["none"],
						code_challenge_methods_supported: ["S256"],
					}),
				);
				return;
			}
			if (url.pathname === "/register") {
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				response.writeHead(201, { "content-type": "application/json" });
				response.end(JSON.stringify({ ...metadata, client_id: "test-client" }));
				return;
			}
			if (url.pathname === "/authorize") {
				expectedChallenge = url.searchParams.get("code_challenge") ?? undefined;
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", "test-code");
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/token") {
				const params = new URLSearchParams(await readBody(request));
				if (params.get("grant_type") === "refresh_token") {
					refreshes++;
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify({ access_token: "refreshed-token", token_type: "Bearer" }));
					return;
				}
				const challenge = createHash("sha256")
					.update(params.get("code_verifier") ?? "")
					.digest("base64url");
				if (params.get("code") !== "test-code" || challenge !== expectedChallenge) {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: "invalid_grant" }));
					return;
				}
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({ access_token: "first-token", refresh_token: "refresh-token", token_type: "Bearer" }),
				);
				return;
			}
			if (url.pathname !== "/mcp") {
				response.statusCode = 404;
				response.end();
				return;
			}
			if (request.method === "GET") {
				response.statusCode = 405;
				response.end();
				return;
			}
			if (request.method === "DELETE") {
				response.statusCode = 200;
				response.end();
				return;
			}
			const token = request.headers.authorization;
			if (token !== "Bearer first-token" && token !== "Bearer refreshed-token") {
				await readBody(request);
				response.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource/mcp", scope="org:read"`,
				});
				response.end("Unauthorized");
				return;
			}
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (!("id" in message)) {
				response.statusCode = 202;
				response.end();
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "oauth-test", version: "1.0.0" },
						}
					: { tools: [{ name: "issues", inputSchema: { type: "object" } }] };
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});

		const callback = await OAuthCallbackServer.listen();
		const provider = new TestOAuthProvider(callback.redirectUrl);
		const firstClient = new McpClient({ name: "oauth-test", version: "1.0.0" });
		await expect(
			firstClient.connect(
				new StreamableHttpTransport({
					url: `${origin}/mcp`,
					headers: { Authorization: "Bearer caller-supplied-stale-token" },
					authProvider: adaptOAuthProvider(provider),
					openGetStream: false,
				}),
			),
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		expect(provider.authorizationUrl?.searchParams.get("scope")).toBe("org:read");
		expect(provider.authorizationUrl?.searchParams.get("resource")).toBe(`${origin}/mcp`);

		const callbackResult = callback.waitForCallback("expected-state");
		const authorizationResponse = await fetch(provider.authorizationUrl as URL, { redirect: "manual" });
		await fetch(authorizationResponse.headers.get("location") as string);
		const { code } = await callbackResult;
		expect(
			await authorizeMcp(provider, {
				serverUrl: `${origin}/mcp`,
				authorizationCode: code,
				fetch,
			}),
		).toBe("AUTHORIZED");

		const client = new McpClient({ name: "oauth-test", version: "1.0.0" });
		await client.connect(
			new StreamableHttpTransport({
				url: `${origin}/mcp`,
				headers: { Authorization: "Bearer caller-supplied-stale-token" },
				authProvider: adaptOAuthProvider(provider),
				openGetStream: false,
			}),
		);
		expect(await client.listTools()).toEqual([{ name: "issues", inputSchema: { type: "object" } }]);
		await client.close();

		provider.tokenSet = { ...provider.tokenSet!, access_token: "stale-token" };
		const refreshedClient = new McpClient({ name: "oauth-test", version: "1.0.0" });
		await refreshedClient.connect(
			new StreamableHttpTransport({
				url: `${origin}/mcp`,
				headers: { Authorization: "Bearer caller-supplied-stale-token" },
				authProvider: adaptOAuthProvider(provider),
				openGetStream: false,
			}),
		);
		expect(provider.tokenSet?.access_token).toBe("refreshed-token");
		expect(refreshes).toBe(1);
		await refreshedClient.close();
		await callback.close();
	});

	it("shares one refresh between concurrent 401s when refresh tokens rotate", async () => {
		const grants: string[] = [];
		const origin = await listen(async (request, response, serverOrigin) => {
			const url = new URL(request.url ?? "/", serverOrigin);
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						// Issuer without the trailing slash that URL parsing adds to the fallback server URL.
						issuer: serverOrigin,
						authorization_endpoint: `${serverOrigin}/authorize`,
						token_endpoint: `${serverOrigin}/token`,
						response_types_supported: ["code"],
					}),
				);
				return;
			}
			if (url.pathname === "/token") {
				const params = new URLSearchParams(await readBody(request));
				const refreshToken = params.get("refresh_token") ?? "";
				grants.push(refreshToken);
				response.setHeader("content-type", "application/json");
				if (refreshToken !== "r1") {
					response.statusCode = 400;
					response.end(JSON.stringify({ error: "invalid_grant" }));
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
				response.end(
					JSON.stringify({ access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }),
				);
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		const store = new MemoryOAuthStateStore();
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "test" },
			clientId: "client",
			store,
			onRedirect: () => {},
		});
		await provider.saveTokens({ access_token: "a1", refresh_token: "r1", token_type: "Bearer" });
		const auth = adaptOAuthProvider(provider);
		const unauthorized = () => ({
			response: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
			serverUrl: new URL(`${origin}/mcp`),
			fetch,
			token: "a1",
		});
		await Promise.all([auth.onUnauthorized?.(unauthorized()), auth.onUnauthorized?.(unauthorized())]);
		// A late 401 for a request that still carried the old token must not refresh again.
		await auth.onUnauthorized?.(unauthorized());
		expect(grants).toEqual(["r1"]);
		expect(await auth.token()).toBe("a2");
		const state = await store.load();
		expect(state?.tokens?.refresh_token).toBe("r2");
		expect(state?.tokensExpireAt).toBeGreaterThan(Date.now() + 3_500_000);
	});

	it("asks for authorization instead of refreshing when the server needs more scope", async () => {
		const provider = new TestOAuthProvider("http://127.0.0.1/callback");
		provider.client = { client_id: "client" };
		provider.tokenSet = { access_token: "a1", refresh_token: "r1", token_type: "Bearer" };
		const origin = await listen(async (request, response, serverOrigin) => {
			const url = new URL(request.url ?? "/", serverOrigin);
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						issuer: serverOrigin,
						authorization_endpoint: `${serverOrigin}/authorize`,
						token_endpoint: `${serverOrigin}/token`,
						response_types_supported: ["code"],
					}),
				);
				return;
			}
			response.statusCode = url.pathname === "/token" ? 500 : 404;
			response.end();
		});
		const auth = adaptOAuthProvider(provider);
		await expect(
			auth.onUnauthorized?.({
				response: new Response(null, {
					status: 403,
					headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="repo admin"' },
				}),
				serverUrl: new URL(`${origin}/mcp`),
				fetch,
				token: "a1",
			}),
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		expect(provider.authorizationUrl?.searchParams.get("scope")).toBe("repo admin");
		// The working grant is kept until the user authorizes the new scope.
		expect(provider.tokenSet?.access_token).toBe("a1");
	});

	it("binds persisted credentials to the exact MCP server URL", async () => {
		const store = new MemoryOAuthStateStore();
		const first = new McpOAuthProvider({
			serverUrl: "https://one.example/mcp",
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "test" },
			store,
			onRedirect: () => {},
		});
		await first.saveTokens({ access_token: "secret", token_type: "Bearer" });
		expect((await first.tokens())?.access_token).toBe("secret");

		const second = new McpOAuthProvider({
			serverUrl: "https://two.example/mcp",
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "test" },
			store,
			onRedirect: () => {},
		});
		expect(await second.tokens()).toBeUndefined();
	});

	it("rejects authorization metadata whose issuer does not match discovery", async () => {
		const origin = await listen(async (request, response, serverOrigin) => {
			const url = new URL(request.url ?? "/", serverOrigin);
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						issuer: "https://attacker.example",
						authorization_endpoint: `${serverOrigin}/authorize`,
						token_endpoint: `${serverOrigin}/token`,
						response_types_supported: ["code"],
					}),
				);
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		await expect(discoverAuthorizationServerMetadata(origin)).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
	});
});

describe("OAuthCallbackServer pages", () => {
	it("renders plain text by default", async () => {
		const callback = await OAuthCallbackServer.listen();
		try {
			const pending = callback.waitForCallback("s1");
			const response = await fetch(`${callback.redirectUrl}?code=abc&state=s1`);
			expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
			expect(await response.text()).toBe("Authorization complete. You may close this window.");
			expect((await pending).code).toBe("abc");
		} finally {
			await callback.close();
		}
	});

	it("renders pages through renderPage", async () => {
		const pages: OAuthCallbackPage[] = [];
		const callback = await OAuthCallbackServer.listen({
			renderPage: (page) => {
				pages.push(page);
				return page.ok ? "<p>ok</p>" : `<p>${page.message}</p>`;
			},
		});
		try {
			const denied = callback.waitForCallback("s1");
			denied.catch(() => undefined);
			const failure = await fetch(`${callback.redirectUrl}?error=access_denied&error_description=Denied&state=s1`);
			expect(failure.headers.get("content-type")).toBe("text/html; charset=utf-8");
			await expect(denied).rejects.toThrow("Denied");
			expect(pages.at(-1)).toEqual({
				ok: false,
				message: "Authorization failed. You may close this window.",
				details: "Denied",
			});

			const pending = callback.waitForCallback("s2");
			const success = await fetch(`${callback.redirectUrl}?code=abc&state=s2`);
			expect(await success.text()).toBe("<p>ok</p>");
			expect((await pending).code).toBe("abc");
		} finally {
			await callback.close();
		}
	});
});
