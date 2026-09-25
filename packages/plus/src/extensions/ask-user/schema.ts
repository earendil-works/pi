/**
 * TypeBox parameter schema for the ask_user tool (shape adapted from
 * openclaude's AskUserQuestionTool).
 */

import type { Static } from "typebox";
import { Type } from "typebox";

/** Max characters for the short per-question header chip. */
export const CHIP_MAX = 12;
/** The free-text option the UI adds automatically; models must not supply it. */
export const OTHER_LABEL = "Other";
/** Guardrail bounds (also enforced at the schema level where expressible). */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

export const AskUserOptionSchema = Type.Object({
	label: Type.String({ description: "Concise display text (1-5 words) that clearly describes the choice" }),
	description: Type.String({ description: "One sentence explaining what this option means or when to pick it" }),
});

export const AskUserQuestionSchema = Type.Object({
	question: Type.String({ description: "The complete question, specific and ending with a question mark" }),
	header: Type.String({
		description: `Very short label for the question tab (max ${CHIP_MAX} chars), e.g. "Auth method"`,
	}),
	options: Type.Array(AskUserOptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `${MIN_OPTIONS}-${MAX_OPTIONS} mutually exclusive options. Do not add an "Other" option — the UI provides one automatically.`,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set true to let the user select multiple options for this question" }),
	),
});

export const AskUserParams = Type.Object({
	questions: Type.Array(AskUserQuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `${MAX_QUESTIONS} questions max. Phrase questions for users who have not seen the conversation.`,
	}),
});

export type AskUserOption = Static<typeof AskUserOptionSchema>;
export type AskUserQuestion = Static<typeof AskUserQuestionSchema>;
export type AskUserParams = Static<typeof AskUserParams>;
export type AskUserAnswers = Record<string, string>;
