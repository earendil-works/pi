// Exposes native clarification forms only to the interactive main agent.
import { Type } from "typebox";
import { parseQuestionForm } from "../../core/ask/form.ts";
import { type FormResult, QuestionFormView } from "../../core/ask/view.ts";
import { defineTool, type ExtensionAPI } from "../../core/extensions/types.ts";

/** Registers the built-in ask tool, hidden from headless sessions and sub-agents. */
export default function askExtension(pi: ExtensionAPI): void {
	const tool = defineTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user to fill in a native terminal form. Supply one semantic HTML <form>. Use fieldset/legend and labeled input radio/checkbox groups for choices; input text/number/date/email/url, textarea and select (including multiple) for typed answers. Every control needs a name. Context supports headings, paragraphs, lists, tables, pre/code and raster images (img src: HTTP(S), local paths, or base64 data URIs). Use required, min/max, step, minlength/maxlength and pattern for validation; value, checked and selected provide editable defaults. No scripts, CSS, buttons, SVG, passwords or file inputs. Choice groups receive an automatic Other answer. The user must explicitly submit; Escape stops the turn. Returns JSON answers, with numbers as numbers and multi-selections as arrays; unchecked optional choices and empty optional numbers are omitted.",
		promptSnippet: "Ask the user for decisions or missing information through an interactive form",
		promptGuidelines: [
			"Use ask for clarification when the user must choose between materially different options or provide information unavailable from tools. Do not ask for information you can inspect yourself.",
			"Before calling ask, explain the relevant findings and tradeoffs in normal assistant text. Batch related questions into one form, with concise labels and meaningful choices; do not submit an Other option yourself.",
			"Use semantic HTML only. The terminal supplies submission and cancellation. Do not collect secrets. Defaults are suggestions, not authorization.",
		],
		parameters: Type.Object({
			html: Type.String({
				description: "One semantic HTML form, with named controls and labels",
				maxLength: 65_536,
			}),
		}),
		exposure: "hidden",
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI)
				throw new Error(
					"ask is available only to the interactive main agent. Tell the parent agent what information is needed.",
				);
			if (signal?.aborted || ctx.signal?.aborted) throw new Error("Question cancelled");
			const form = parseQuestionForm(params.html);
			const combined =
				signal && ctx.signal
					? AbortSignal.any([signal, ctx.signal])
					: (signal ?? ctx.signal ?? new AbortController().signal);
			const result = await ctx.ui.custom<FormResult>(
				(tui, _theme, keys, done) => new QuestionFormView(form, tui, keys, ctx.cwd, combined, done),
				{
					placement: "aboveEditor",
					blocked: { kind: "question", message: "Answer the agent's questions" },
				},
			);
			if (result.kind === "cancelled") {
				ctx.abort();
				return {
					content: [
						{
							type: "text",
							text: "Question cancelled by the user. The turn has stopped; no answers were submitted.",
						},
					],
					details: { kind: "cancelled" },
					terminate: true,
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(result.answers) }], details: result };
		},
	});
	pi.registerTool(tool);
	pi.on("session_start", (_event, ctx) => {
		pi.registerTool({ ...tool, exposure: ctx.mode === "tui" ? "model-only" : "hidden" });
	});
}
