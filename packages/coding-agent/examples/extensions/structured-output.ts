/**
 * Structured Output Tool
 *
 * Demonstrates `terminate: true` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */

import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

interface StructuredOutputDetails {
	headline: string;
	summary: string;
	actionItems: string[];
}

const structuredOutputTool = defineTool({
	name: "structured_output",
	label: "Structured Output",
	description:
		"Return a final structured answer. Use this as your last action when the user asks for structured output or a machine-readable summary.",
	promptSnippet: "Emit a final structured answer as a terminating tool result",
	promptGuidelines: [
		"Use structured_output as your final action when the user asks for structured output, JSON-like output, or a machine-readable summary.",
		"After calling structured_output, do not emit another assistant response in the same turn.",
	],
	parameters: Type.Object({
		headline: Type.String({ description: "Short title for the result" }),
		summary: Type.String({ description: "One-paragraph summary" }),
		actionItems: Type.Array(Type.String(), { description: "Concrete next steps or key bullets" }),
	}),

	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `Saved structured output: ${params.headline}` }],
			details: {
				headline: params.headline,
				summary: params.summary,
				actionItems: params.actionItems,
			} satisfies StructuredOutputDetails,
			terminate: true,
		};
	},

	renderResult(result, _options, theme) {
		const details = result.details as StructuredOutputDetails | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		const lines = [
			theme.fg("toolTitle", theme.bold(details.headline)),
			theme.fg("text", details.summary),
			"",
			...details.actionItems.map((item, index) => theme.fg("muted", `${index + 1}. ${item}`)),
		];
		return new Text(lines.join("\n"), 0, 0);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(structuredOutputTool);
}
