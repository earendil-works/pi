/**
 * ask_user tool (openclaude-style AskUserQuestion port): the model asks the
 * user 1-4 structured questions (options with descriptions, optional
 * multi-select, automatic "Other" free-text) and continues with the answers.
 *
 * In TUI mode a tabbed dialog is shown via ctx.ui.custom; in RPC mode the
 * built-in select/input dialogs are used sequentially; in print/JSON mode the
 * tool throws, producing an error tool result so the model proceeds with its
 * own assumptions.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { AskUserDialogComponent } from "./component.ts";
import { askViaRpcDialogs } from "./fallback.ts";
import type { AskUserAnswers } from "./schema.ts";
import { AskUserParams } from "./schema.ts";
import { formatAnswers, validateQuestions } from "./validate.ts";

const DESCRIPTION =
	"Ask the user multiple choice questions to gather information, clarify ambiguity, understand " +
	"preferences, make decisions or offer them choices. Use when you need input during execution: " +
	"gather requirements, clarify ambiguous instructions, or get decisions on implementation choices. " +
	'Users can always pick "Other" to type a custom answer. Use multiSelect: true to allow several ' +
	'answers per question. If you recommend an option, list it first and add "(Recommended)" to its ' +
	"label. In non-interactive mode this tool is unavailable — proceed with reasonable assumptions " +
	"instead of asking.";

const PROMPT_SNIPPET =
	"ask_user: ask the user 1-4 multiple-choice questions (2-4 options each, optional multi-select, " +
	'automatic "Other" free-text) to clarify requirements or offer choices mid-task';

export function registerAskUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		parameters: AskUserParams,
		// User interaction must not race other tool calls.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const invalid = validateQuestions(params.questions);
			if (invalid) throw new Error(`ask_user: ${invalid}`);
			if (!ctx.hasUI) {
				throw new Error("ask_user is not available in non-interactive mode; proceed with reasonable assumptions");
			}

			let answers: AskUserAnswers | undefined;
			if (ctx.mode === "tui") {
				answers = await ctx.ui.custom<AskUserAnswers | undefined>(
					(_tui, theme, keybindings, done) =>
						new AskUserDialogComponent(params.questions, theme, keybindings, done),
					{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
				);
			} else {
				answers = await askViaRpcDialogs(ctx, params.questions);
			}

			signal?.throwIfAborted();
			if (answers === undefined) throw new Error("User declined to answer the questions");
			return {
				content: [{ type: "text", text: formatAnswers(params.questions, answers) }],
				details: { questions: params.questions, answers },
			};
		},

		renderCall(args, theme) {
			const headers = args.questions.map((q) => q.header).join(", ");
			return new Text(theme.fg("toolTitle", theme.bold("Ask User ")) + theme.fg("accent", `[${headers}]`), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { answers: Record<string, string> } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const lines = Object.entries(details.answers).map(
				([question, answer]) => `${theme.fg("muted", `${question} →`)} ${theme.fg("text", answer)}`,
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
