/**
 * Reload Runtime Extension
 *
 * Demonstrates deferred ctx.requestReload() from command and tool contexts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload. Treat the request as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			ctx.requestReload();
			return;
		},
	});

	// LLM-callable tool. The request is coalesced and runs after this tool result settles.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ctx.requestReload();
			return {
				content: [{ type: "text", text: "Reload requested." }],
				details: {},
			};
		},
	});
}
