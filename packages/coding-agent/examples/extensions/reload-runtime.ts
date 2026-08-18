/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable
 * tool that queues a follow-up command to trigger reload.
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

	// LLM-callable tool. Tools get ExtensionContext, so they cannot call ctx.reload() directly.
	// Instead, queue a follow-up user command that executes the command above.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
				details: {},
			};
		},
	});
}
