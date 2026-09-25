/**
 * RPC-mode fallback for ask_user: the RPC UI context supports select/confirm/
 * input but not custom components, so questions are asked sequentially with
 * the built-in dialogs. Returns undefined when the host cancels any dialog.
 */

import type { ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { AskUserAnswers, AskUserQuestion } from "./schema.ts";
import { OTHER_LABEL } from "./schema.ts";

export async function askViaRpcDialogs(
	ctx: ExtensionContext,
	questions: AskUserQuestion[],
): Promise<AskUserAnswers | undefined> {
	const answers: AskUserAnswers = {};
	for (const question of questions) {
		if (question.multiSelect === true) {
			const chosen: string[] = [];
			for (const option of question.options) {
				const include = await ctx.ui.confirm(question.header, `Include "${option.label}"?`);
				if (include) chosen.push(option.label);
			}
			const extra = await ctx.ui.input(question.header, "Additional free-text answer (empty for none)");
			if (extra === undefined) return undefined;
			if (extra.trim() !== "") chosen.push(extra.trim());
			if (chosen.length === 0) return undefined; // host gave no answer at all
			answers[question.question] = chosen.join(", ");
			continue;
		}
		const labels = question.options.map((option) => option.label);
		const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [...labels, OTHER_LABEL]);
		if (choice === undefined) return undefined;
		if (choice === OTHER_LABEL) {
			const text = await ctx.ui.input(question.header, "Your answer");
			if (text === undefined || text.trim() === "") return undefined;
			answers[question.question] = text.trim();
			continue;
		}
		answers[question.question] = choice;
	}
	return answers;
}
