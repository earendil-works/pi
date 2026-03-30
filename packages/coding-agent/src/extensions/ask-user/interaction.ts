import type { AskUserAnswer, AskUserRequest, AskUserResult } from "./types.js";

export type AskUserInteractionHandler = (request: AskUserRequest) => Promise<AskUserResult>;

let askUserInteractionHandler: AskUserInteractionHandler | null = null;

function buildAnswerSummary(answers: AskUserAnswer[]): string {
	return answers.map((answer, index) => `${index + 1}. ${answer.topic}: ${answer.answer}`).join("\n");
}

export function setAskUserInteractionHandler(handler: AskUserInteractionHandler | null): void {
	askUserInteractionHandler = handler;
}

export async function promptAskUser(request: AskUserRequest): Promise<AskUserResult> {
	if (askUserInteractionHandler) {
		return askUserInteractionHandler(request);
	}
	throw new Error("ask_user requires an interactive handler");
}

export function formatAskUserSummary(answers: AskUserAnswer[]): string {
	if (answers.length === 0) return "No answers captured.";
	return buildAnswerSummary(answers);
}
