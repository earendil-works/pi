/**
 * Guardrail validation and answer formatting for the ask_user tool.
 * Pure functions — no TUI or provider dependencies.
 */

import type { AskUserAnswers, AskUserQuestion } from "./schema.ts";
import { CHIP_MAX, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, OTHER_LABEL } from "./schema.ts";

/**
 * Validate guardrails that TypeBox cannot express cross-field. Returns the
 * first violation as a human-readable string, or undefined when valid.
 */
export function validateQuestions(questions: AskUserQuestion[]): string | undefined {
	if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
		return `questions must contain between 1 and ${MAX_QUESTIONS} questions`;
	}
	const seenTexts = new Set<string>();
	for (const q of questions) {
		if (seenTexts.has(q.question)) return `duplicate question text: "${q.question}"`;
		seenTexts.add(q.question);
		if (q.header.length > CHIP_MAX) {
			return `header "${q.header}" exceeds ${CHIP_MAX} characters`;
		}
		if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
			return `question "${q.question}" must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} options`;
		}
		const seenLabels = new Set<string>();
		for (const option of q.options) {
			if (seenLabels.has(option.label)) {
				return `duplicate option label "${option.label}" in question "${q.question}"`;
			}
			seenLabels.add(option.label);
			if (option.label.toLowerCase() === OTHER_LABEL.toLowerCase()) {
				return `do not provide an "${OTHER_LABEL}" option — the UI adds it automatically`;
			}
		}
	}
	return undefined;
}

/** Serialize the answers into the tool-result text the model reads. */
export function formatAnswers(questions: AskUserQuestion[], answers: AskUserAnswers): string {
	const parts = questions.map((q) => {
		const answer = answers[q.question] ?? "(no answer)";
		return `"${q.question}"="${answer}"`;
	});
	return `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`;
}
