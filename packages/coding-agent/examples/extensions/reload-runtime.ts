/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from an LLM-callable tool. Tool-triggered
 * reloads are deferred until the agent turn is idle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// During a tool call, ctx.reload() requests a reload that
	// runs after the current agent turn is fully idle.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await ctx.reload();
			return {
				content: [{ type: "text", text: "Reload requested. It will run after this turn finishes." }],
				details: {},
				terminate: true,
			};
		},
	});
}
