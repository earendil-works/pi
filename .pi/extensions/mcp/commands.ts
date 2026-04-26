import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const LIST_TOOLS_TIMEOUT_MS = 5_000;

export function listToolsWithTimeout(client: Client, serverName: string) {
	type Result = Awaited<ReturnType<typeof client.listTools>>;
	return new Promise<Result>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${serverName}: listTools timed out`)),
			LIST_TOOLS_TIMEOUT_MS,
		);
		client.listTools().then(
			(result) => { clearTimeout(timer); resolve(result); },
			(err: unknown) => { clearTimeout(timer); reject(err); },
		);
	});
}

/** Register the /mcp slash command that lists connected servers and their tool counts. */
export function registerMcpCommand(pi: ExtensionAPI, clients: Map<string, Client>): void {
	pi.registerCommand("mcp", {
		description: "List connected MCP servers and their tools",
		handler: async (_args, ctx) => {
			if (clients.size === 0) {
				ctx.ui.notify("MCP: no servers connected", "info");
				return;
			}

			const lines: string[] = [`MCP servers (${clients.size} connected):`];
			for (const [name, client] of clients) {
				try {
					const { tools } = await listToolsWithTimeout(client, name);
					const toolNames = tools.map((t) => t.name).join(", ");
					lines.push(`  ${name}: ${tools.length} tool${tools.length === 1 ? "" : "s"} — ${toolNames || "(none)"}`);
				} catch (err) {
					lines.push(`  ${name}: error fetching tools — ${err}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
