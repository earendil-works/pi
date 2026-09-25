import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** MCP server protected by OAuth, with its own authorization server (discovery, DCR, PKCE, refresh). */
async function startOAuthMcpServer() {
	const log: string[] = [];
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
		if (request.method !== "POST") {
			response.writeHead(request.method === "GET" ? 405 : 200).end();
			return;
		}
		const token = request.headers.authorization?.replace(/^Bearer /, "");
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
		json(response, 200, { jsonrpc: "2.0", id: message.id, result });
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", origin);
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
				});
			case "/register": {
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				log.push("register");
				return json(response, 201, { ...metadata, client_id: "client-1" });
			}
			case "/authorize": {
				const code = `code-${challenges.size + 1}`;
				challenges.set(code, url.searchParams.get("code_challenge") ?? "");
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			case "/token": {
				const params = new URLSearchParams(await readBody(request));
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
		/** Simulates access token expiry. */
		expireAccessTokens: () => validTokens.clear(),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function createUiContext(options: {
	notifications: string[];
	/** Answers the paste-redirect-URL prompt; by default it waits until sign-in completes. */
	answerInput?: () => Promise<string | undefined>;
}): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: (_title, _placeholder, opts) =>
			options.answerInput?.() ??
			new Promise((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })),
		notify: (message) => options.notifications.push(message),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("AgentSession MCP OAuth", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(browser: "follow" | "paste") {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const backend = new InMemoryAuthStorageBackend();
		const entry: McpServerEntry = { name: "issues", config: { url: server.url, exposure: "direct" }, source: "test" };
		const notifications: string[] = [];
		let redirectLocation: Promise<string> | undefined;
		const harness: Harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					credentials: new McpOAuthCredentialStore(backend),
					openUrl: (url) => {
						if (browser === "follow") {
							// The browser follows the authorization redirect to the loopback callback.
							void fetch(url);
						} else {
							// The browser cannot reach the callback; the user pastes the redirect URL.
							redirectLocation = fetch(url, { redirect: "manual" }).then(
								(response) => response.headers.get("location") ?? "",
							);
						}
					},
				}),
			],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({
			uiContext: createUiContext({
				notifications,
				answerInput: browser === "paste" ? async () => redirectLocation : undefined,
			}),
		});
		return { harness, server, notifications, backend };
	}

	async function callWhoami(harness: Harness): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__issues__whoami", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const before = harness.session.messages.length;
		await harness.session.prompt("who am i");
		const result = harness.session.messages
			.slice(before)
			.find((message): message is ToolResultMessage => message.role === "toolResult");
		if (!result) throw new Error("no tool result");
		return result;
	}

	function text(message: ToolResultMessage): string {
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}

	it("signs in through the browser, refreshes expired tokens, and signs out", async () => {
		const { harness, server, notifications, backend } = await setup("follow");

		await harness.session.prompt("/mcp");
		expect(notifications).toContain('MCP server "issues" requires sign-in. Run /mcp login issues.');
		expect(notifications.at(-1)).toBe("issues: needs sign-in, run /mcp login issues (direct)");

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(server.log).toEqual(["401 none", "register", "token code"]);
		expect(backend.withLock((current) => ({ result: current }))).toContain('"access_token": "access-1"');

		expect(text(await callWhoami(harness))).toBe("token access-1");

		// An expired access token is refreshed without user interaction.
		server.expireAccessTokens();
		expect(text(await callWhoami(harness))).toBe("token access-2");
		expect(server.log.slice(-3)).toEqual(["401 access-1", "token refresh", "call access-2"]);

		await harness.session.prompt("/mcp logout issues");
		expect(notifications.at(-1)).toBe('Signed out of MCP server "issues".');
		const result = await callWhoami(harness);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe('MCP server "issues" requires sign-in. Run /mcp login issues.');
	});

	it("accepts a pasted redirect URL when the browser cannot reach the callback", async () => {
		const { harness, server, notifications } = await setup("paste");

		await harness.session.prompt("/mcp login");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(text(await callWhoami(harness))).toBe(`token access-1`);
		expect(server.log).toContain("token code");
	});
});
