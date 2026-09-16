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
