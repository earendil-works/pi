/**
 * Commands Extension
 *
 * Demonstrates the pi.getCommands() API by providing a /commands command
 * that lists all available slash commands in the current session.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /commands to see available commands
 * 3. Use /commands extensions to filter by source
 */

import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export default function commandsExtension(pi: ExtensionAPI) {
	pi.registerCommand("commands", {
		description: "List available slash commands",
		getArgumentCompletions: (prefix) => {
			const sources = ["extension", "prompt", "skill"];
			const filtered = sources.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const commands = pi.getCommands();
			const sourceFilter = args.trim() as "extension" | "prompt" | "skill" | "";

			// Filter by source if specified
			const filtered = sourceFilter ? commands.filter((c) => c.source === sourceFilter) : commands;

			if (filtered.length === 0) {
				ctx.ui.notify(sourceFilter ? `No ${sourceFilter} commands found` : "No commands found", "info");
				return;
			}

			// Build selection items grouped by source
			const formatCommand = (cmd: SlashCommandInfo): string => {
				const desc = cmd.description ? ` - ${cmd.description}` : "";
				return `/${cmd.name}${desc}`;
			};

			const items: string[] = [];
			const sources: Array<{ key: "extension" | "prompt" | "skill"; label: string }> = [
				{ key: "extension", label: "Extensions" },
				{ key: "prompt", label: "Prompts" },
				{ key: "skill", label: "Skills" },
			];

			for (const { key, label } of sources) {
				const cmds = filtered.filter((c) => c.source === key);
				if (cmds.length > 0) {
					items.push(`--- ${label} ---`);
					items.push(...cmds.map(formatCommand));
				}
			}

			// Show in a selector (user can scroll and see all commands)
			const selected = await ctx.ui.select("Available Commands", items);

			// If user selected a command (not a header), offer to show its path
			if (selected && !selected.startsWith("---")) {
				const cmdName = selected.split(" - ")[0].slice(1); // Remove leading /
				const cmd = commands.find((c) => c.name === cmdName);
				if (cmd?.sourceInfo.path) {
					const showPath = await ctx.ui.confirm(cmd.name, `View source path?\n${cmd.sourceInfo.path}`);
					if (showPath) {
						ctx.ui.notify(cmd.sourceInfo.path, "info");
					}
				}
			}
		},
	});
}
