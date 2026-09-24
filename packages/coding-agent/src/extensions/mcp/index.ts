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
 */

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	McpClient,
	type Tool as McpTool,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { getAgentDir, VERSION } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import { CODEMODE_TOOL_NAME } from "../../core/tools/codemode.ts";
import { type LoadedMcpConfig, loadMcpConfig, type McpServerEntry } from "./config.ts";
import { createMcpToolDefinition, createMcpToolName } from "./tools.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;

type ServerState = "connecting" | "connected" | "failed" | "closed";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: (entry: McpServerEntry, cwd: string) => McpTransport;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createDefaultTransport(entry: McpServerEntry, cwd: string): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
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
class McpServerConnection {
	readonly entry: McpServerEntry;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private closed = false;
	private readonly cwd: string;
	private readonly createTransport: (entry: McpServerEntry, cwd: string) => McpTransport;
	private readonly onTools: (connection: McpServerConnection) => void;

	constructor(
		entry: McpServerEntry,
		cwd: string,
		createTransport: (entry: McpServerEntry, cwd: string) => McpTransport,
		onTools: (connection: McpServerConnection) => void,
	) {
		this.entry = entry;
		this.cwd = cwd;
		this.createTransport = createTransport;
		this.onTools = onTools;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
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
			transport = this.createTransport(this.entry, this.cwd);
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
		const exposure = connection.entry.config.exposure ?? "codemode";
		const tools = connection.state === "connected" ? `, ${connection.tools.length} tools` : "";
		const error = connection.error ? `\n    ${connection.error.split("\n").join("\n    ")}` : "";
		return `${connection.entry.name}: ${connection.state}${tools} (${exposure})${error}`;
	});
	for (const error of configErrors) lines.push(`config error: ${error}`);
	return lines.join("\n");
}

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let connections: McpServerConnection[] = [];
		let configErrors: string[] = [];
		let pending: Promise<unknown> | undefined;

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
						getClient: () => connection.getClient(),
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

		pi.on("session_start", (_event, ctx) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			for (const error of configErrors) ctx.ui.notify(`MCP config: ${error}`, "warning");
			const createTransport = options.createTransport ?? createDefaultTransport;
			connections = loaded.servers.map(
				(entry) => new McpServerConnection(entry, ctx.cwd, createTransport, registerTools),
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
			description: "Show MCP server status",
			handler: async (_args, ctx) => {
				await pending;
				ctx.ui.notify(formatStatus(connections, configErrors), "info");
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
