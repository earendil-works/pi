/** Require per-call approval for model-invoked tools, including custom tools. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("confirm-tools", {
		description: "Comma-separated exact tool names requiring approval; * confirms every tool (default)",
		type: "string",
		default: "*",
	});

	pi.on("tool_call", async (event, ctx) => {
		const names = String(pi.getFlag("confirm-tools") ?? "*")
			.split(",")
			.map((name) => name.trim());
		if (names.some((name) => name.length === 0)) {
			return { block: true, reason: "Invalid --confirm-tools: expected tool names or *" };
		}
		if (!names.includes("*") && !names.includes(event.toolName)) return;

		const signal = ctx.signal;
		if (!ctx.hasUI || signal?.aborted) {
			return { block: true, reason: "Tool blocked: approval unavailable or turn aborted" };
		}

		const approved = await ctx.ui.confirm(
			"Allow this tool call?",
			JSON.stringify({ tool: event.toolName, arguments: event.input }, null, 2),
			{ signal },
		);
		if (!approved || signal?.aborted) {
			return { block: true, reason: "Tool blocked: approval denied or cancelled" };
		}
	});
}
