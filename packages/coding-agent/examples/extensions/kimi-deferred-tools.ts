/**
 * Minimal Kimi deferred-tool loading demo.
 *
 *   pi -e ./kimi-deferred-tools.ts
 *    example prompt: Use the available tools to calculate 100 + 500. Do not calculate it yourself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function calculate(_expr: string): string {
	return "42";
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "Calculator",
		label: "Calculator",
		description: "Evaluate a simple arithmetic expression.",
		parameters: Type.Object({
			expr: Type.String({ description: "An expression such as 100 + 500" }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: calculate(params.expr) }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description: "Find and activate tools for a capability.",
		promptSnippet: "Search for additional tools when the active tools cannot perform the task",
		parameters: Type.Object({
			query: Type.String({ description: "Capability to search for" }),
		}),
		async execute(_toolCallId, params) {
			if (!params.query.toLowerCase().includes("calc")) {
				return {
					content: [{ type: "text", text: "The relevant tools do not exist." }],
					details: { matches: [], added: [] },
				};
			}

			const active = pi.getActiveTools();
			const added = active.includes("Calculator") ? [] : ["Calculator"];
			if (added.length > 0) pi.setActiveTools([...active, ...added]);

			return {
				content: [{ type: "text", text: "Success. Found 1 matching tool(s)" }],
				details: { matches: ["Calculator"], added },
			};
		},
	});

	pi.on("session_start", () => {
		pi.setActiveTools(["tool_search"]);
	});
}
