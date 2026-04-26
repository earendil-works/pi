import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listToolsWithTimeout, registerMcpCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { createTransport } from "./transport.js";
import type { SSEClientTransport, StdioClientTransport } from "./transport.js";
import { validateParams, wrapSchema } from "./schema.js";

const CONNECT_TIMEOUT_MS = 10_000;

function connectWithTimeout(
	client: Client,
	transport: StdioClientTransport | SSEClientTransport,
	serverName: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// Close the transport so the spawned subprocess is not abandoned.
			transport.close().catch(() => {});
			reject(new Error(`MCP server "${serverName}" did not respond within ${CONNECT_TIMEOUT_MS}ms`));
		}, CONNECT_TIMEOUT_MS);
		client.connect(transport).then(
			() => { clearTimeout(timer); resolve(); },
			(err: unknown) => { clearTimeout(timer); reject(err); },
		);
	});
}

export default function (pi: ExtensionAPI): void {
	const config = loadConfig(process.cwd());

	if (!config.servers.length) return;

	const clients = new Map<string, Client>();
	// Tracks tools registered with pi across session cycles to avoid duplicate registration.
	const registeredTools = new Set<string>();

	registerMcpCommand(pi, clients);

	pi.on("session_start", async (_event, ctx) => {
		await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
		clients.clear();

		for (const server of config.servers) {
			try {
				const transport = createTransport(server);
				const client = new Client(
					{ name: "pi-mcp", version: "0.1.0" },
					{ capabilities: {} },
				);
				await connectWithTimeout(client, transport, server.name);

				const { tools } = await listToolsWithTimeout(client, server.name);
				clients.set(server.name, client);

				for (const tool of tools) {
					const toolName = `mcp__${server.name}__${tool.name}`;

					if (registeredTools.has(toolName)) continue;
					registeredTools.add(toolName);

					const inputSchema = (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;

					pi.registerTool({
						name: toolName,
						label: `[MCP:${server.name}] ${tool.name}`,
						description: tool.description ?? tool.name,
						promptSnippet: tool.description ?? tool.name,
						parameters: wrapSchema(inputSchema),
						prepareArguments: (args) =>
							args !== null && typeof args === "object" && !Array.isArray(args)
								? (args as Record<string, unknown>)
								: {},

						async execute(_id, params, signal, _onUpdate, _ctx) {
							if (signal?.aborted) {
								throw new Error("Cancelled");
							}

							const validation = validateParams(inputSchema, params);
							if (!validation.valid) {
								throw new Error(`Invalid arguments: ${validation.errors.join("; ")}`);
							}

							// Read the current client from the map so a session restart picks up the
							// fresh connection rather than the captured (now-closed) client reference.
							const currentClient = clients.get(server.name);
							if (!currentClient) {
								throw new Error(`MCP server "${server.name}" is not connected`);
							}

							const callPromise = currentClient.callTool({
								name: tool.name,
								arguments: params as Record<string, unknown>,
							});

							const result = await (signal
								? Promise.race([
									callPromise,
									new Promise<never>((_, reject) => {
										signal.addEventListener(
											"abort",
											() => reject(new Error("Cancelled")),
											{ once: true },
										);
									}),
								])
								: callPromise);

							const content = Array.isArray(result.content)
								? (result.content as Array<{ type: string; text?: string }>)
								: [];
							const textParts = content
								.filter((c) => c.type === "text" && c.text !== undefined)
								.map((c) => c.text as string);
							const hasNonText = content.some((c) => c.type !== "text");
							const text =
								textParts.length > 0
									? textParts.join("\n")
									: hasNonText
										? "(non-text content omitted)"
										: "(no text output)";

							return {
								content: [{ type: "text", text }],
								details: result,
							};
						},
					});
				}

				ctx.ui.notify(`MCP: connected ${server.name} (${tools.length} tool${tools.length === 1 ? "" : "s"})`, "info");
				ctx.ui.setStatus(`mcp-${server.name}`, `MCP:${server.name}(${tools.length})`);
			} catch (err) {
				ctx.ui.notify(`MCP: failed to connect ${server.name}: ${err}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
		clients.clear();
	});
}
