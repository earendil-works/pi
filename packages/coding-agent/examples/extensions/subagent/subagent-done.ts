import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description:
			"Call this tool when you have completed your task. It closes this session so the parent can collect your final summary.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Closing subagent session." }],
				details: {},
			};
		},
	});
}
