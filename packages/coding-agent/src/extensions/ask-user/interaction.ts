import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { sanitizeScopeName } from "./storage.js";
import type { AskUserAnswer, AskUserRequest, AskUserResult } from "./types.js";

export type AskUserInteractionHandler = (request: AskUserRequest) => Promise<AskUserResult>;

let askUserInteractionHandler: AskUserInteractionHandler | null = null;

function buildAnswerSummary(answers: AskUserAnswer[]): string {
	return answers.map((answer, index) => `${index + 1}. ${answer.topic}: ${answer.answer}`).join("\n");
}

async function promptLine(rl: ReturnType<typeof createInterface>, message: string): Promise<string> {
	const value = await rl.question(message);
	return value.trim();
}

async function fallbackPrompt(request: AskUserRequest): Promise<AskUserResult> {
	const rl = createInterface({ input, output });

	try {
		let scopeInput = request.scopeName?.trim() ?? "";
		while (!scopeInput) {
			scopeInput = await promptLine(rl, "Scope name: ");
		}

		const scopeName = sanitizeScopeName(scopeInput);
		const answers: AskUserAnswer[] = [];

		for (const question of request.questions) {
			output.write(`\n${question.topic}\n${question.prompt}\n`);
			const options = question.options.length > 0 ? question.options : ["(type your answer)"];
			for (const [index, option] of options.entries()) {
				output.write(`  ${index + 1}. ${option}\n`);
			}
			if (question.allowCustom !== false) {
				output.write(`  ${options.length + 1}. Custom answer\n`);
			}

			let answerText = "";
			let source: AskUserAnswer["source"] = "custom";
			while (!answerText) {
				const raw = await promptLine(rl, "> ");
				const selected = Number.parseInt(raw, 10);
				if (Number.isFinite(selected) && selected >= 1 && selected <= options.length) {
					answerText = options[selected - 1] ?? "";
					source = "option";
					break;
				}
				if (question.allowCustom !== false && selected === options.length + 1) {
					answerText = await promptLine(rl, "Custom answer: ");
					source = "custom";
					break;
				}
				if (raw.trim()) {
					answerText = raw.trim();
					source = "custom";
				}
			}

			answers.push({
				questionId: question.id,
				topic: question.topic,
				prompt: question.prompt,
				answer: answerText,
				source,
				field: question.field,
				entryId: question.entryId,
			});
		}

		const summary = buildAnswerSummary(answers);
		return {
			scopeName,
			sanitizedScopeName: scopeName,
			answers,
			files: [],
			summary,
		};
	} finally {
		rl.close();
	}
}

export function setAskUserInteractionHandler(handler: AskUserInteractionHandler | null): void {
	askUserInteractionHandler = handler;
}

export async function promptAskUser(request: AskUserRequest): Promise<AskUserResult> {
	if (askUserInteractionHandler) {
		return askUserInteractionHandler(request);
	}
	return fallbackPrompt(request);
}

export function formatAskUserSummary(answers: AskUserAnswer[]): string {
	if (answers.length === 0) return "No answers captured.";
	return buildAnswerSummary(answers);
}
