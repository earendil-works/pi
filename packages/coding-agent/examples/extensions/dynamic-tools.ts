/**
 * Dynamic Tools Extension
 *
 * Demonstrates registering tools after session initialization.
 *
 * - Registers one tool during session_start
 * - Registers additional tools at runtime via /add-echo-tool <name>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const ECHO_PARAMS = Type.Object({
	message: Type.String({ description: "Message to echo" }),
});

function normalizeToolName(input: string): string | undefined {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) return undefined;
	if (!/^[a-z0-9_]+$/.test(trimmed)) return undefined;
	return trimmed;
}

export default function dynamicToolsExtension(pi: ExtensionAPI) {
	const registeredToolNames = new Set<string>();

	const registerEchoTool = (name: string, label: string, prefix: string): boolean => {
		if (registeredToolNames.has(name)) {
			return false;
		}

		registeredToolNames.add(name);
		pi.registerTool({
			name,
			label,
			description: `Echo a message with prefix: ${prefix}`,
			promptSnippet: `Echo back user-provided text with ${prefix.trim()} prefix`,
			promptGuidelines: ["Use echo_session when the user asks for exact echo output."],
			parameters: ECHO_PARAMS,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `${prefix}${params.message}` }],
					details: { tool: name, prefix },
				};
			},
		});

		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		registerEchoTool("echo_session", "Echo Session", "[session] ");
		ctx.ui.notify("Registered dynamic tool: echo_session", "info");
	});

	pi.registerCommand("add-echo-tool", {
		description: "Register a new echo tool dynamically: /add-echo-tool <tool_name>",
		handler: async (args, ctx) => {
			const toolName = normalizeToolName(args);
			if (!toolName) {
				ctx.ui.notify("Usage: /add-echo-tool <tool_name> (lowercase, numbers, underscores)", "warning");
				return;
			}

			const created = registerEchoTool(toolName, `Echo ${toolName}`, `[${toolName}] `);
			if (!created) {
				ctx.ui.notify(`Tool already registered: ${toolName}`, "warning");
				return;
			}

			ctx.ui.notify(`Registered dynamic tool: ${toolName}`, "info");
		},
	});
}
