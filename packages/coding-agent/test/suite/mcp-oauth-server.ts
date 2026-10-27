import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/**
 * MCP server protected by OAuth, with its own authorization server (discovery, DCR, PKCE, refresh).
 * `iss` is sent as the `iss` parameter of authorization responses (RFC 9207). `issParameter` advertises
 * that parameter and sends the server's issuer. `cimd` advertises Client ID Metadata Documents.
 * `redirectPath` replaces the path of the redirect URI, like a mixed-up authorization server.
 * The MCP endpoint assigns a session, so closing a connection sends a DELETE. Paths added to `stall`
 * accept requests and never answer them, like an unresponsive server.
 */
export async function startOAuthMcpServer(
	options: { iss?: string; issParameter?: boolean; cimd?: boolean; redirectPath?: string } = {},
) {
	const log: string[] = [];
	const registrations: Record<string, unknown>[] = [];
	const authorizations: URLSearchParams[] = [];
	const tokenRequests: URLSearchParams[] = [];
	const deletes: (string | undefined)[] = [];
	const stall = new Set<string>();
	const stalled: { path: string; request: IncomingMessage }[] = [];
	const validTokens = new Set<string>();
	const refreshTokens = new Set<string>();
	const challenges = new Map<string, string>();
	let issued = 0;
	let origin = "";

	const issueTokens = () => {
		issued++;
		const tokens = { access_token: `access-${issued}`, refresh_token: `refresh-${issued}` };
		validTokens.add(tokens.access_token);
		refreshTokens.add(tokens.refresh_token);
		return { ...tokens, token_type: "Bearer", expires_in: 3600 };
	};

	const handleMcp = async (request: IncomingMessage, response: ServerResponse) => {
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		if (request.method === "DELETE") deletes.push(token);
		if (request.method !== "POST") {
			response.writeHead(request.method === "GET" ? 405 : 200).end();
			return;
		}
		if (!token || !validTokens.has(token)) {
			log.push(`401 ${token ?? "none"}`);
			response
				.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as { id?: number; method: string; params?: unknown };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "issues", version: "1.0.0" },
			};
		} else if (message.method === "tools/list") {
			result = { tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] };
		} else if (message.method === "tools/call") {
			log.push(`call ${token}`);
			result = { content: [{ type: "text", text: `token ${token}` }] };
		} else {
			result = {};
		}
		json(response, 200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": "session-1" });
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", origin);
		if (stall.has(url.pathname)) {
			stalled.push({ path: url.pathname, request });
			return;
		}
		switch (url.pathname) {
			case "/mcp":
				return handleMcp(request, response);
			case "/.well-known/oauth-protected-resource/mcp":
				return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
			case "/.well-known/oauth-authorization-server":
				return json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
					...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
					...(options.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
				});
			case "/register": {
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				log.push("register");
				registrations.push(metadata);
				return json(response, 201, { ...metadata, client_id: "client-1" });
			}
			case "/authorize": {
				authorizations.push(url.searchParams);
				const code = `code-${challenges.size + 1}`;
				challenges.set(code, url.searchParams.get("code_challenge") ?? "");
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				if (options.redirectPath) redirect.pathname = options.redirectPath;
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				const iss = options.iss ?? (options.issParameter ? origin : undefined);
				if (iss) redirect.searchParams.set("iss", iss);
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			case "/token": {
				const params = new URLSearchParams(await readBody(request));
				tokenRequests.push(params);
				if (params.get("grant_type") === "authorization_code") {
					const challenge = challenges.get(params.get("code") ?? "");
					const verifier = createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url");
					if (!challenge || challenge !== verifier) return json(response, 400, { error: "invalid_grant" });
					challenges.delete(params.get("code") ?? "");
					log.push("token code");
					return json(response, 200, issueTokens());
				}
				const refresh = params.get("refresh_token") ?? "";
				if (!refreshTokens.delete(refresh)) return json(response, 400, { error: "invalid_grant" });
				log.push("token refresh");
				return json(response, 200, issueTokens());
			}
			default:
				response.writeHead(404).end();
		}
	};

	const server: Server = createServer((request, response) => {
		void handle(request, response).catch((error) => {
			response.writeHead(500).end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind to TCP");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		url: `${origin}/mcp`,
		log,
		/** Client metadata of dynamic client registrations. */
		registrations,
		/** Query parameters of authorization requests. */
		authorizations,
		/** Parameters of token requests. */
		tokenRequests,
		/** Access tokens of session DELETE requests. */
		deletes,
		stall,
		/** Requests to stalled paths, still open unless the client gave up. */
		stalled,
		/** Simulates access token expiry. */
		expireAccessTokens: () => validTokens.clear(),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
