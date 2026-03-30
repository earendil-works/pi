export type AskUserMode = "validation_contract" | "specification";

export type AskUserQuestionField = "surface" | "commandOrAction" | "expect" | "notes";

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
	scopeName?: string;
	questions: AskUserQuestion[];
	notes?: string;
	suggestedEntries?: ValidationContractEntry[];
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

export interface ValidationContractEntry {
	id: string;
	surface?: string;
	commandOrAction?: string;
	expect?: string;
	notes?: string;
}

export interface ValidationContractDocument {
	version: 1;
	scopeName: string;
	createdAt: string;
	updatedAt: string;
	objectiveHistory: string[];
	entries: ValidationContractEntry[];
	answers: AskUserAnswer[];
	notes: string[];
}

export interface SpecClarificationItem {
	id: string;
	topic: string;
	question: string;
	answer: string;
	source: AskUserAnswerSource;
	updatedAt: string;
}

export interface SpecClarificationDocument {
	version: 1;
	scopeName: string;
	createdAt: string;
	updatedAt: string;
	objectiveHistory: string[];
	items: SpecClarificationItem[];
	notes: string[];
}

export interface AskUserResult {
	scopeName: string;
	sanitizedScopeName: string;
	answers: AskUserAnswer[];
	validationContract?: ValidationContractDocument;
	specClarifications?: SpecClarificationDocument;
	files: string[];
	summary: string;
}

export interface AskUserScopePointer {
	sessionId: string;
	scopeName: string;
	updatedAt: string;
}
