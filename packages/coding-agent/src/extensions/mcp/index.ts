/**
 * Built-in MCP integration.
 *
 * Connects the servers from `mcp.json` when a session starts and registers their tools as
 * `mcp__<server>__<tool>`. By default (`"exposure": "codemode"`) the tools are only callable from
 * codemode scripts, which keeps large MCP tool lists out of the model's tool declarations; the
 * codemode tool is activated for that. `"exposure": "direct"` declares them to the model as well.
 *
 * Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission
 * extensions apply to MCP tools the same way they do to built-in tools.
 *
 * HTTP servers without an `Authorization` header authenticate with OAuth. A server that needs a
 * sign-in shows as "needs sign-in" until the user runs `/mcp login <server>`.
 */

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AuthProvider,
	type CallToolResult,
	McpClient,
	type McpRequestOptions,
	type Tool as McpTool,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAgentDir, VERSION } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import { CODEMODE_TOOL_NAME } from "../../core/tools/codemode.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { type LoadedMcpConfig, loadMcpConfig, type McpServerEntry } from "./config.ts";
import {
	createMcpAuthProvider,
	McpOAuthCredentialStore,
	type McpOAuthSettings,
	McpSignInCancelledError,
	signInMcpServer,
} from "./oauth.ts";
import { createMcpToolDefinition, createMcpToolName, type McpToolCaller } from "./tools.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;

type ServerState = "connecting" | "connected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function signInRequiredMessage(name: string): string {
	return `MCP server "${name}" requires sign-in. Run /mcp login ${name}.`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header. */
function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config)) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: config.command,
		args: config.args,
		cwd: resolve(cwd, config.cwd ?? "."),
		env,
		stderr: "pipe",
	});
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
class McpServerConnection implements McpToolCaller {
	readonly entry: McpServerEntry;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	/** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
	challenge: OAuthChallenge | undefined;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private closed = false;
	private readonly cwd: string;
	private readonly createTransport: McpTransportFactory;
	private readonly authProvider: AuthProvider | undefined;
	private readonly onTools: (connection: McpServerConnection) => void;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		onTools: (connection: McpServerConnection) => void;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.createTransport = options.createTransport;
		this.onTools = options.onTools;
		const url = this.oauthUrl;
		this.authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: options.credentials.forServer(url),
					settings: this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = challenge;
					},
				})
			: undefined;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Server URL when the server authenticates with OAuth. */
	get oauthUrl(): string | undefined {
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
		};
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	async callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		const client = await this.getClient();
		try {
			return await client.callTool(name, args, options);
		} catch (error) {
			if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
			await this.dropClient(client);
			this.markNeedsAuth();
			throw new Error(signInRequiredMessage(this.entry.name));
		}
	}

	/** Connect again with fresh credentials, for example after signing in. */
	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.getClient();
	}

	/** Disconnect after the stored credentials were removed. */
	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	private markNeedsAuth(): void {
		this.state = "needs-auth";
		this.error = undefined;
	}

	private async dropClient(client: McpClient): Promise<void> {
		if (this.client === client) this.client = undefined;
		await client.close().catch(() => undefined);
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		let transport: McpTransport | undefined;
		try {
			transport = this.createTransport(this.entry, this.cwd, this.authProvider);
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(client);
			});
			const tools = await client.listTools();
			if (this.closed) throw new Error("shut down while connecting");
			this.client = client;
			this.tools = tools;
			this.state = "connected";
			this.error = undefined;
			this.onTools(this);
			return client;
		} catch (error) {
			await client.close().catch(() => undefined);
			if (error instanceof McpOAuthAuthorizationRequiredError && !this.closed) {
				this.markNeedsAuth();
				throw new Error(signInRequiredMessage(this.entry.name));
			}
			const stderr = transport instanceof StdioTransport ? transport.stderr.trim().slice(-STDERR_TAIL_CHARS) : "";
			this.state = this.closed ? "closed" : "failed";
			this.error = stderr ? `${errorMessage(error)}\n${stderr}` : errorMessage(error);
			throw new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
		}
	}

	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.state = "closed";
		const client = this.client;
		this.client = undefined;
		await client?.close().catch(() => undefined);
	}
}

function formatStatus(connections: readonly McpServerConnection[], configErrors: readonly string[]): string {
	if (connections.length === 0 && configErrors.length === 0) {
		return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`;
	}
	const lines = connections.map((connection) => {
		const { name, config } = connection.entry;
		const exposure = config.exposure ?? "codemode";
		if (connection.state === "needs-auth") return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
		const tools = connection.state === "connected" ? `, ${connection.tools.length} tools` : "";
		const error = connection.error ? `\n    ${connection.error.split("\n").join("\n    ")}` : "";
		return `${name}: ${connection.state}${tools} (${exposure})${error}`;
	});
	for (const error of configErrors) lines.push(`config error: ${error}`);
	return lines.join("\n");
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let connections: McpServerConnection[] = [];
		let configErrors: string[] = [];
		let pending: Promise<unknown> | undefined;
		const credentials = options.credentials ?? new McpOAuthCredentialStore();
		const openUrl = options.openUrl ?? openBrowser;

		const registerTools = (connection: McpServerConnection) => {
			const { name: server, config } = connection.entry;
			const exposure = config.exposure ?? "codemode";
			for (const tool of connection.tools) {
				const name = createMcpToolName(server, tool.name);
				pi.registerTool(
					createMcpToolDefinition({
						server,
						tool,
						name,
						exposure,
						timeoutMs: connection.timeoutMs,
						getClient: async () => connection,
					}),
				);
			}
		};

		/** Codemode-exposed tools are unreachable without the codemode tool, so turn it on. */
		const ensureCodemodeActive = (ctx: ExtensionContext) => {
			const needsCodemode = connections.some(
				(connection) =>
					connection.state === "connected" && (connection.entry.config.exposure ?? "codemode") === "codemode",
			);
			if (!needsCodemode || pi.getActiveTools().includes(CODEMODE_TOOL_NAME)) return;
			if (!pi.getAllTools().some((tool) => tool.name === CODEMODE_TOOL_NAME)) {
				ctx.ui.notify(
					'MCP tools use "exposure": "codemode" but the codemode tool is not available; they cannot be called.',
					"warning",
				);
				return;
			}
			pi.setActiveTools([...pi.getActiveTools(), CODEMODE_TOOL_NAME]);
		};

		/** Resolve the server for `/mcp login|logout`, asking when the name is omitted and ambiguous. */
		const pickOAuthServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
		): Promise<McpServerConnection | undefined> => {
			const candidates = connections.filter((connection) => connection.oauthUrl);
			if (name) {
				const connection = connections.find((candidate) => candidate.entry.name === name);
				if (!connection) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!connection.oauthUrl) {
					ctx.ui.notify(
						`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`,
						"error",
					);
				}
				return connection?.oauthUrl ? connection : undefined;
			}
			if (candidates.length === 0) {
				ctx.ui.notify("No configured MCP server uses OAuth.", "info");
				return undefined;
			}
			const needsAuth = candidates.filter((connection) => connection.state === "needs-auth");
			if (candidates.length === 1) return candidates[0];
			if (needsAuth.length === 1) return needsAuth[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((connection) => connection.entry.name),
			);
			return candidates.find((connection) => connection.entry.name === choice);
		};

		const login = async (connection: McpServerConnection, url: string, ctx: ExtensionCommandContext) => {
			const { name } = connection.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			try {
				await signInMcpServer({
					serverUrl: url,
					store: credentials.forServer(url),
					settings: connection.oauthSettings(),
					challenge: connection.challenge,
					prompt: {
						showAuthorizationUrl: (authorizationUrl) => {
							ctx.ui.notify(
								`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`,
								"info",
							);
							openUrl(authorizationUrl.href);
						},
						promptForRedirectUrl: (signal) =>
							ctx.ui.input(
								`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
								"http://127.0.0.1:.../oauth/callback?code=...",
								{ signal },
							),
					},
				});
			} catch (error) {
				if (error instanceof McpSignInCancelledError) ctx.ui.notify("MCP sign-in cancelled.", "info");
				else ctx.ui.notify(`Sign-in to MCP server "${name}" failed: ${errorMessage(error)}`, "error");
				return;
			}
			try {
				await connection.reconnect();
			} catch (error) {
				ctx.ui.notify(`Signed in, but ${errorMessage(error)}`, "error");
				return;
			}
			ensureCodemodeActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`, "info");
		};

		const logout = async (connection: McpServerConnection, url: string, ctx: ExtensionCommandContext) => {
			const { name } = connection.entry;
			const removed = credentials.remove(url);
			await connection.signOut();
			ctx.ui.notify(
				removed ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`,
				"info",
			);
		};

		pi.on("session_start", (_event, ctx) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			for (const error of configErrors) ctx.ui.notify(`MCP config: ${error}`, "warning");
			const createTransport = options.createTransport ?? createDefaultTransport;
			connections = loaded.servers.map(
				(entry) =>
					new McpServerConnection({ entry, cwd: ctx.cwd, createTransport, credentials, onTools: registerTools }),
			);
			if (connections.length === 0) return;
			pending = Promise.allSettled(
				connections.map((connection) =>
					connection.getClient().catch((error: unknown) => ctx.ui.notify(errorMessage(error), "warning")),
				),
			).then(() => ensureCodemodeActive(ctx));
		});

		// The first prompt waits for startup connections so their tools are available to it.
		pi.on("before_agent_start", async () => {
			await pending;
		});

		pi.on("session_shutdown", async () => {
			const closing = connections;
			connections = [];
			await Promise.all(closing.map((connection) => connection.close()));
		});

		pi.registerCommand("mcp", {
			description: "Show MCP server status, or sign in and out of OAuth servers",
			getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout") return null;
				const items = connections
					.filter((connection) => connection.oauthUrl && connection.entry.name.startsWith(server))
					.map((connection) => ({
						value: `${action} ${connection.entry.name}`,
						label: connection.entry.name,
						description: connection.state === "needs-auth" ? "needs sign-in" : connection.state,
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				await pending;
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					ctx.ui.notify(formatStatus(connections, configErrors), "info");
					return;
				}
				if ((action !== "login" && action !== "logout") || extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				const connection = await pickOAuthServer(name, ctx);
				const url = connection?.oauthUrl;
				if (!connection || !url) return;
				if (action === "login") await login(connection, url, ctx);
				else await logout(connection, url, ctx);
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
