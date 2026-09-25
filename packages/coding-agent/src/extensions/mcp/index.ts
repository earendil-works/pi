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

import { resolve } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.ts";
import { CODEMODE_TOOL_NAME } from "../../core/tools/codemode.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { type LoadedMcpConfig, loadMcpConfig } from "./config.ts";
import type { McpOAuthCredentialStore } from "./oauth.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpTransportFactory } from "./runtime.ts";
import { createMcpToolDefinition, createMcpToolName } from "./tools.ts";

export type { McpTransportFactory } from "./runtime.ts";

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
		/** Bumped on every session start and shutdown so a runtime load that resolves late is dropped. */
		let generation = 0;
		let credentials = options.credentials;
		const openUrl = options.openUrl ?? openBrowser;

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

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
			const runtime = await loadMcpRuntime();
			try {
				await runtime.signInMcpServer({
					serverUrl: url,
					store: getCredentials(runtime).forServer(url),
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
				if (error instanceof runtime.McpSignInCancelledError) ctx.ui.notify("MCP sign-in cancelled.", "info");
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
			const removed = getCredentials(await loadMcpRuntime()).remove(url);
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
			const current = ++generation;
			connections = [];
			if (loaded.servers.length === 0) return;
			// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
			// event loop turn lets the first render happen before loading and connecting.
			pending = new Promise((resolve) => setImmediate(resolve))
				.then(() => loadMcpRuntime())
				.then((runtime) => {
					if (current !== generation) return;
					const createTransport = options.createTransport ?? runtime.createDefaultTransport;
					const store = getCredentials(runtime);
					connections = loaded.servers.map(
						(entry) =>
							new runtime.McpServerConnection({
								entry,
								cwd: ctx.cwd,
								createTransport,
								credentials: store,
								onTools: registerTools,
							}),
					);
					return Promise.allSettled(
						connections.map((connection) =>
							connection.getClient().catch((error: unknown) => ctx.ui.notify(errorMessage(error), "warning")),
						),
					).then(() => ensureCodemodeActive(ctx));
				})
				.catch((error: unknown) => ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error"));
		});

		// The first prompt waits for startup connections so their tools are available to it.
		pi.on("before_agent_start", async () => {
			await pending;
		});

		pi.on("session_shutdown", async () => {
			generation++;
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
