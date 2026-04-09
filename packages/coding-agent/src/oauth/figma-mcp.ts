import { randomBytes } from "node:crypto";
import http from "node:http";
import { loadOAuthCredentials, type OAuthCredentials, saveOAuthCredentials } from "@kennyfrc/mu-ai";
import { generatePKCE } from "../../../ai/src/utils/oauth/pkce.js";
import type { McpConfig } from "../mcp/config.js";
import { loadMcpConfig } from "../mcp/config.js";
import { detectFigmaPilotServer } from "../mcp/figma-pilot.js";

const FIGMA_PROTECTED_RESOURCE_URL = "https://mcp.figma.com/.well-known/oauth-protected-resource";
const FIGMA_AUTH_SERVER_URL = "https://api.figma.com/.well-known/oauth-authorization-server";
const FIGMA_DCR_URL = "https://api.figma.com/v1/oauth/mcp/register";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8788/callback";
const FIGMA_PROVIDER_ID = "figma-mcp";

type FigmaProtectedResourceMetadata = {
	resource?: string;
	authorization_servers?: string[];
	scopes_supported?: string[];
};

type FigmaAuthorizationServerMetadata = {
	authorization_endpoint: string;
	token_endpoint: string;
	scopes_supported?: string[];
};

type DcrResponse = {
	client_id: string;
	client_secret: string;
	client_id_issued_at: number;
	client_secret_expires_at: number;
	client_name: string;
	redirect_uris: string[];
	scope: string;
};

export interface FigmaOAuthClientConfig {
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	serverName: string;
	serverUrl: string;
}

export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

function createState(): string {
	return randomBytes(16).toString("hex");
}

function getEnvValue(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const value = process.env[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveFigmaOAuthClientConfig(config: McpConfig): FigmaOAuthClientConfig {
	const figma = detectFigmaPilotServer(config);
	if (!figma) {
		throw new Error("No Figma MCP server configured. Add the Figma server to MCP config first.");
	}

	const definition = config.mcpServers[figma.serverName];
	const oauth = definition?.oauth;

	// Check config/env first, then fall back to stored credentials from DCR
	const storedCreds = loadOAuthCredentials(FIGMA_PROVIDER_ID);
	const clientId = oauth?.clientId ?? getEnvValue("MU_FIGMA_OAUTH_CLIENT_ID") ?? storedCreds?.client_id;
	let clientSecret =
		oauth?.clientSecret ?? getEnvValue(oauth?.clientSecretEnv) ?? getEnvValue("MU_FIGMA_OAUTH_CLIENT_SECRET");
	if (!clientSecret && storedCreds?.client_secret) {
		clientSecret = storedCreds.client_secret;
	}

	const redirectUri = oauth?.redirectUri ?? getEnvValue("MU_FIGMA_OAUTH_REDIRECT_URI") ?? DEFAULT_REDIRECT_URI;

	// clientId may be undefined - DCR will provide it
	return {
		clientId: clientId ?? "",
		...(clientSecret ? { clientSecret } : {}),
		redirectUri,
		serverName: figma.serverName,
		serverUrl: figma.url,
	};
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

export async function discoverFigmaOAuthMetadata(): Promise<{
	protectedResource: FigmaProtectedResourceMetadata;
	authorizationServer: FigmaAuthorizationServerMetadata;
}> {
	const protectedResource = await fetchJson<FigmaProtectedResourceMetadata>(FIGMA_PROTECTED_RESOURCE_URL);
	const authorizationServer = await fetchJson<FigmaAuthorizationServerMetadata>(FIGMA_AUTH_SERVER_URL);
	return { protectedResource, authorizationServer };
}

/**
 * Register a new OAuth client via Figma's Dynamic Client Registration (DCR) endpoint.
 * Uses "Codex" as client_name (open source, allowlisted by Figma).
 */
export async function registerFigmaMcpClient(
	redirectUri: string = DEFAULT_REDIRECT_URI,
): Promise<{ clientId: string; clientSecret: string }> {
	const response = await fetch(FIGMA_DCR_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({
			client_name: "Codex",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: "mcp:connect",
		}),
	});

	if (!response.ok) {
		throw new Error(`DCR failed: HTTP ${response.status}`);
	}

	const data = (await response.json()) as DcrResponse;

	// Store the credentials alongside any existing OAuth data
	const existing = loadOAuthCredentials(FIGMA_PROVIDER_ID) ?? {
		type: "oauth" as const,
		refresh: "",
		access: "",
		expires: 0,
	};
	saveOAuthCredentials(FIGMA_PROVIDER_ID, {
		...existing,
		client_id: data.client_id,
		client_secret: data.client_secret,
	});

	return { clientId: data.client_id, clientSecret: data.client_secret };
}

function startCallbackServer(
	redirectUri: string,
	expectedState: string,
): Promise<{
	server: http.Server;
	getCode: () => Promise<string>;
}> {
	const url = new URL(redirectUri);
	const port = Number(url.port || 80);
	const hostname = url.hostname;
	const pathname = url.pathname;

	return new Promise((resolve, reject) => {
		let resolver: ((code: string) => void) | null = null;
		const pending = new Promise<string>((resolveCode) => {
			resolver = resolveCode;
		});

		const server = http.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? "/", `${url.protocol}//${req.headers.host ?? `${hostname}:${port}`}`);
			if (requestUrl.pathname !== pathname) {
				res.writeHead(404).end("Not found");
				return;
			}

			const state = requestUrl.searchParams.get("state") ?? "";
			const code = requestUrl.searchParams.get("code") ?? "";
			if (!code || state !== expectedState) {
				res.writeHead(400).end("OAuth callback validation failed");
				return;
			}

			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html><body><h1>Figma authentication successful</h1><p>You can close this window.</p></body></html>");
			resolver?.(code);
		});

		server.once("error", reject);
		server.listen(port, hostname, () => resolve({ server, getCode: () => pending }));
	});
}

async function exchangeCodeForToken(
	code: string,
	verifier: string,
	clientConfig: FigmaOAuthClientConfig,
	metadata: FigmaAuthorizationServerMetadata,
): Promise<OAuthCredentials> {
	const params = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		client_id: clientConfig.clientId,
		redirect_uri: clientConfig.redirectUri,
		code_verifier: verifier,
	});
	if (clientConfig.clientSecret) {
		params.set("client_secret", clientConfig.clientSecret);
	}

	const response = await fetch(metadata.token_endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: params,
	});
	if (!response.ok) {
		throw new Error(`Figma token exchange failed: HTTP ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};
	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: Date.now() + payload.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export async function loginFigmaMcp(
	onAuth: (info: OAuthAuthInfo) => void,
	onProgress?: (message: string) => void,
	config?: McpConfig,
): Promise<void> {
	const mcpConfig = config ?? (await loadMcpConfig());
	let clientConfig = resolveFigmaOAuthClientConfig(mcpConfig);

	// If no clientId OR no clientSecret, perform DCR to get fresh credentials
	// DCR credentials require both client_id and client_secret for token operations
	if (!clientConfig.clientId || !clientConfig.clientSecret) {
		onProgress?.("Registering OAuth client via DCR...");
		const { clientId, clientSecret } = await registerFigmaMcpClient(clientConfig.redirectUri);
		clientConfig = {
			...clientConfig,
			clientId,
			clientSecret,
		};
	}

	const { authorizationServer, protectedResource } = await discoverFigmaOAuthMetadata();
	const { verifier, challenge } = await generatePKCE();
	const state = createState();
	const { server, getCode } = await startCallbackServer(clientConfig.redirectUri, state);

	try {
		const authUrl = new URL(authorizationServer.authorization_endpoint);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", clientConfig.clientId);
		authUrl.searchParams.set("redirect_uri", clientConfig.redirectUri);
		authUrl.searchParams.set("scope", protectedResource.scopes_supported?.join(" ") || "mcp:connect");
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
		authUrl.searchParams.set("state", state);

		onAuth({
			url: authUrl.toString(),
			instructions: "Complete the Figma OAuth sign-in in your browser. The callback will be captured automatically.",
		});
		onProgress?.("Waiting for Figma OAuth callback...");

		const code = await getCode();
		onProgress?.("Exchanging Figma authorization code for tokens...");
		const credentials = await exchangeCodeForToken(code, verifier, clientConfig, authorizationServer);
		// Preserve client credentials in storage
		credentials.client_id = clientConfig.clientId;
		if (clientConfig.clientSecret) {
			credentials.client_secret = clientConfig.clientSecret;
		}
		saveOAuthCredentials(FIGMA_PROVIDER_ID, credentials);
	} finally {
		server.close();
	}
}

export async function refreshFigmaMcpToken(refreshToken: string, _config?: McpConfig): Promise<OAuthCredentials> {
	// Load stored credentials directly - require client_id for refresh
	const creds = loadOAuthCredentials(FIGMA_PROVIDER_ID);
	if (!creds?.client_id) {
		throw new Error("No client credentials stored for figma-mcp");
	}

	const { authorizationServer } = await discoverFigmaOAuthMetadata();
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: creds.client_id,
	});
	if (creds.client_secret) {
		params.set("client_secret", creds.client_secret);
	}

	const response = await fetch(authorizationServer.token_endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: params,
	});
	if (!response.ok) {
		throw new Error(`Figma token refresh failed: HTTP ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};
	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token ?? refreshToken,
		expires: Date.now() + payload.expires_in * 1000 - 5 * 60 * 1000,
		// Preserve client credentials
		client_id: creds.client_id,
		client_secret: creds.client_secret,
	};
}

export async function getFigmaOAuthAccessToken(config?: McpConfig): Promise<string | null> {
	const credentials = loadOAuthCredentials(FIGMA_PROVIDER_ID);
	if (!credentials) return null;

	// Check if we have client credentials for refresh
	// Old credentials without DCR won't have these - user needs to re-login
	if (!credentials.client_id || !credentials.client_secret) {
		return null;
	}

	// If token is still valid, return it
	if (Date.now() < credentials.expires) {
		return credentials.access;
	}

	// Token expired - refresh it
	try {
		const refreshed = await refreshFigmaMcpToken(credentials.refresh, config);
		saveOAuthCredentials(FIGMA_PROVIDER_ID, refreshed);
		return refreshed.access;
	} catch (error) {
		// Refresh failed - user needs to re-login
		console.error("Figma token refresh failed:", error);
		return null;
	}
}
