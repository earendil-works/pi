/**
 * Reload Runtime Extension
 *
 * Demonstrates immediate ctx.reload() from ExtensionCommandContext and
 * deferred ctx.requestReload() from a tool's ExtensionContext.
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

	// LLM-callable tool. The host defers the canonical reload until the runtime is idle.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ctx.requestReload();
			return {
				content: [{ type: "text", text: "Reload requested for the next idle state." }],
				details: {},
			};
		},
	});
}
