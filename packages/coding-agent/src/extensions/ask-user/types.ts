export type AskUserMode = "validation_contract" | "specification" | "clarify";

export type AskUserQuestionField = string;

export type AskUserAnswerSource = "option" | "custom";

export interface AskUserQuestion {
	id: string;
	prompt: string;
	topic: string;
	options: string[];
	allowCustom?: boolean;
	field?: AskUserQuestionField;
	entryId?: string;
}

export interface AskUserRequest {
	mode: AskUserMode;
	objective: string;
	questions: AskUserQuestion[];
	notes?: string;
}

export interface AskUserAnswer {
	questionId: string;
	topic: string;
	prompt: string;
	answer: string;
	source: AskUserAnswerSource;
	field?: AskUserQuestionField;
	entryId?: string;
}

export interface AskUserResult {
	answers: AskUserAnswer[];
	summary: string;
}
