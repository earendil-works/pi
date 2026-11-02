/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable
 * tool that requests a reload once the agent has settled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Tools do not receive ExtensionCommandContext, so they cannot call
	// ctx.reload(), and Pi cannot reload while the agent is running. The tool records the
	// request and ends the run; the agent_settled handler then runs the command above.
	let reloadRequested = false;

	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			reloadRequested = true;
			return {
				content: [{ type: "text", text: "Reload requested. Pi reloads after this response." }],
				details: {},
				terminate: true,
			};
		},
	});

	pi.on("agent_settled", () => {
		if (!reloadRequested) return;
		reloadRequested = false;
		// Sent from agent_settled, the command runs after every settled handler finishes, while
		// the agent is idle. expandPromptTemplates dispatches it as a command, not as model input.
		pi.sendUserMessage("/reload-runtime", { expandPromptTemplates: true });
	});
}
