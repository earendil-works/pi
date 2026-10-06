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
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	type OAuthTokens,
	registerClient,
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
				// Empty and null optional fields count as absent (#10266).
				response.end(JSON.stringify({ ...metadata, client_id: "test-client", client_secret: "" }));
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
					response.end(
						JSON.stringify({
							access_token: "refreshed-token",
							token_type: "Bearer",
							refresh_token: "",
							expires_in: null,
						}),
					);
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
					JSON.stringify({
						access_token: "first-token",
						refresh_token: "refresh-token",
						token_type: "Bearer",
						scope: "",
					}),
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
					// An empty scope falls through to the resource metadata's scopes_supported.
					"www-authenticate": `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource/mcp", scope=""`,
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
		// Neither token response names a scope, so the grant has the requested scope.
		expect(provider.tokenSet).toEqual({
			access_token: "refreshed-token",
			refresh_token: "refresh-token",
			token_type: "Bearer",
			scope: "org:read",
		});
		expect(refreshes).toBe(1);
		await refreshedClient.close();
		await callback.close();
	});

	it("shares one refresh between concurrent 401s when refresh tokens rotate", async () => {
		const grants: string[] = [];
		const origin = await listen(async (request, response, serverOrigin) => {
			const url = new URL(request.url ?? "/", serverOrigin);
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				// Invalid resource metadata falls back to the server origin instead of failing discovery.
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: ["not a url"] }));
				return;
			}
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
		provider.tokenSet = { access_token: "a1", refresh_token: "r1", token_type: "Bearer", scope: "repo read:org" };
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
		// The challenge may list only the missing scopes; the new grant keeps the old ones too.
		expect(provider.authorizationUrl?.searchParams.get("scope")).toBe("repo read:org admin");
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

	// #10493
	it("registers with an application_type derived from the redirect URIs unless one is set", async () => {
		const bodies: Record<string, unknown>[] = [];
		const origin = await listen(async (request, response) => {
			const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
			bodies.push(metadata);
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ ...metadata, client_id: "client" }));
		});
		const register = (redirect_uris: string[], application_type?: string) =>
			registerClient(origin, {
				clientMetadata: { redirect_uris, ...(application_type ? { application_type } : {}) },
			});
		await register(["http://127.0.0.1:1234/callback"]);
		await register(["http://[::1]/callback"]);
		await register(["com.example.app:/callback"]);
		await register(["https://app.example/callback"]);
		await register(["http://localhost/callback"], "web");
		expect(bodies.map((body) => body.application_type)).toEqual(["native", "native", "native", "web", "web"]);
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

	// #10172
	it("uses a configured authorization server metadata document as is", async () => {
		const origin = await listen(async (request, response, serverOrigin) => {
			const url = new URL(request.url ?? "/", serverOrigin);
			response.setHeader("content-type", "application/json");
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				// Names the MCP server itself, which serves no authorization server metadata.
				response.end(JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: [serverOrigin] }));
			} else if (url.pathname === "/idp/metadata.json") {
				response.end(
					JSON.stringify({
						// Not derivable from the document URL; a configured document is not checked.
						issuer: "https://idp.example",
						authorization_endpoint: `${serverOrigin}/idp/authorize`,
						token_endpoint: `${serverOrigin}/idp/token`,
						response_types_supported: ["code"],
					}),
				);
			} else {
				response.statusCode = 404;
				response.end();
			}
		});
		const provider = new TestOAuthProvider("http://127.0.0.1/callback");
		provider.client = { client_id: "client" };
		const options = {
			serverUrl: `${origin}/mcp`,
			authorizationServerMetadataUrl: new URL(`${origin}/idp/metadata.json`),
		};
		expect(await authorizeMcp(provider, options)).toBe("REDIRECT");
		const authorizationUrl = provider.authorizationUrl as URL;
		expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${origin}/idp/authorize`);
		expect(authorizationUrl.searchParams.get("resource")).toBe(`${origin}/mcp`);

		const insecure = { ...options, authorizationServerMetadataUrl: new URL("http://idp.example/metadata.json") };
		await expect(authorizeMcp(provider, insecure)).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
	});

	it("exchanges a code only when its iss parameter names the authorization server", async () => {
		const codes: string[] = [];
		const origin = await listen(async (request, response) => {
			codes.push(new URLSearchParams(await readBody(request)).get("code") ?? "");
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ access_token: "token", token_type: "Bearer" }));
		});
		const exchange = (code: string, iss: string | undefined, issParameterSupported: boolean) => {
			const provider = new TestOAuthProvider("http://127.0.0.1/callback");
			provider.client = { client_id: "client" };
			provider.verifier = "verifier";
			provider.discovery = {
				authorizationServerUrl: origin,
				authorizationServerMetadata: {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					authorization_response_iss_parameter_supported: issParameterSupported,
				},
			};
			return authorizeMcp(provider, { serverUrl: `${origin}/mcp`, authorizationCode: code, iss });
		};
		await expect(exchange("other", "https://attacker.example", false)).rejects.toBeInstanceOf(
			OAuthIssuerMismatchError,
		);
		await expect(exchange("missing", undefined, true)).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
		expect(await exchange("matching", origin, true)).toBe("AUTHORIZED");
		// Servers that do not promise the parameter may omit it.
		expect(await exchange("omitted", undefined, false)).toBe("AUTHORIZED");
		expect(codes).toEqual(["matching", "omitted"]);
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

	// #10302
	it("rejects a response on another path than the expected one", async () => {
		const callback = await OAuthCallbackServer.listen({ extraPaths: ["/callback/server-id"] });
		try {
			const origin = new URL(callback.redirectUrl).origin;
			const mixedUp = callback.waitForCallback("s1", "/callback/server-id");
			mixedUp.catch(() => undefined);
			const wrong = await fetch(`${origin}/callback?code=abc&state=s1`);
			expect(wrong.status).toBe(400);
			await expect(mixedUp).rejects.toThrow("arrived on another redirect URI");

			const pending = callback.waitForCallback("s2", "/callback/server-id");
			const right = await fetch(`${origin}/callback/server-id?code=abc&state=s2`);
			expect(right.status).toBe(200);
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
