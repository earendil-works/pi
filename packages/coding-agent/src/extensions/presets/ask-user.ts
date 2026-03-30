import type { AgentTool, Message } from "@kennyfrc/mu-ai";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { formatAskUserSummary, promptAskUser } from "../ask-user/interaction.js";
import {
	getScopePaths,
	loadScopeState,
	mergeSpecClarifications,
	mergeValidationContract,
	persistScopeDocuments,
	sanitizeScopeName,
} from "../ask-user/storage.js";
import type { AskUserAnswer, AskUserQuestion, AskUserRequest } from "../ask-user/types.js";
import type { ExtensionApi } from "../types.js";
import { eraseAgentTool } from "../types.js";

const QUESTION_SCHEMA = Type.Object({
	id: Type.String({ minLength: 1 }),
	prompt: Type.String({ minLength: 1 }),
	topic: Type.String({ minLength: 1 }),
	options: Type.Array(Type.String(), { default: [] }),
	allowCustom: Type.Optional(Type.Boolean()),
	field: Type.Optional(Type.String({ minLength: 1 })),
	entryId: Type.Optional(Type.String({ minLength: 1 })),
});

const askUserSchema = Type.Object({
	mode: Type.Union([Type.Literal("validation_contract"), Type.Literal("specification"), Type.Literal("clarify")]),
	objective: Type.String({ minLength: 1 }),
	scopeName: Type.Optional(Type.String({ minLength: 1 })),
	notes: Type.Optional(Type.String()),
	questions: Type.Array(QUESTION_SCHEMA, { minItems: 1, maxItems: 6 }),
	suggestedEntries: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ minLength: 1 }),
				surface: Type.Optional(Type.String()),
				commandOrAction: Type.Optional(Type.String()),
				expect: Type.Optional(Type.String()),
				notes: Type.Optional(Type.String()),
			}),
		),
	),
});

const CONTEXT_MARKER = "<ask_user_context";

function isAskUserContextMessage(message: Message): boolean {
	if (message.role !== "user" || typeof message.content !== "string") {
		return false;
	}
	return message.content.startsWith(CONTEXT_MARKER);
}

function buildContextPayload(): string | null {
	const sessionId = process.env.MU_SESSION_ID ?? null;
	const state = loadScopeState({ sessionId });
	if (!state.scopeName) return null;

	const blocks: string[] = [`${CONTEXT_MARKER} scope="${state.scopeName}">`];

	if (state.validationContract) {
		const contractPath =
			state.paths?.validationContractPath ??
			getScopePaths({ scopeName: state.scopeName, sessionId }).validationContractPath;
		blocks.push(`Validation contract path: ${contractPath}`);
		if (state.validationContract.entries.length > 0) {
			blocks.push("Validation entries:");
			for (const entry of state.validationContract.entries) {
				const fragments = [
					entry.surface ? `surface=${entry.surface}` : undefined,
					entry.commandOrAction ? `action=${entry.commandOrAction}` : undefined,
					entry.expect ? `expect=${entry.expect}` : undefined,
					entry.notes ? `notes=${entry.notes}` : undefined,
				].filter((fragment): fragment is string => fragment !== undefined);
				blocks.push(`- ${entry.id}: ${fragments.join(" | ") || "no structured fields yet"}`);
			}
		} else {
			blocks.push("Validation contract exists but does not yet contain normalized entries.");
		}
	}

	if (state.specClarifications) {
		const specPath =
			state.paths?.specClarificationsPath ??
			getScopePaths({ scopeName: state.scopeName, sessionId }).specClarificationsPath;
		blocks.push(`Specification clarifications path: ${specPath}`);
		for (const item of state.specClarifications.items) {
			blocks.push(`- ${item.topic}: ${item.answer}`);
		}
	}

	blocks.push(
		"If problem-discovery, validation, or specification details are still unclear, prefer ask_user before guessing. Validation-contract clarification is the primary use case.",
	);
	blocks.push("</ask_user_context>");
	return blocks.join("\n");
}

function injectContextMessage(messages: Message[], contextText: string): Message[] {
	const cleaned = messages.filter((message) => !isAskUserContextMessage(message));
	const injected: Message = {
		role: "user",
		content: contextText,
		timestamp: Date.now(),
	};

	let insertIndex = cleaned.length;
	for (let index = cleaned.length - 1; index >= 0; index--) {
		if (cleaned[index]?.role === "user") {
			insertIndex = index;
			break;
		}
	}

	return [...cleaned.slice(0, insertIndex), injected, ...cleaned.slice(insertIndex)];
}

function normalizeQuestions(questions: ReadonlyArray<Static<typeof QUESTION_SCHEMA>>): AskUserQuestion[] {
	return questions.map((question) => ({
		id: question.id,
		prompt: question.prompt,
		topic: question.topic,
		options: question.options,
		allowCustom: question.allowCustom,
		field: question.field,
		entryId: question.entryId,
	}));
}

function buildToolContent(args: {
	request: AskUserRequest;
	scopeName: string;
	summary: string;
	files: string[];
}): string {
	const lines = [
		`Scope: ${args.scopeName}`,
		`Mode: ${args.request.mode}`,
		"",
		args.summary.trim() || "No answers captured.",
	];

	if (args.files.length > 0) {
		lines.push("", "Files:");
		for (const file of args.files) {
			lines.push(`- ${file}`);
		}
	}

	return lines.join("\n");
}

function shouldMergeValidationContract(request: AskUserRequest, answers: AskUserAnswer[]): boolean {
	if (request.mode === "validation_contract") {
		return true;
	}
	if ((request.suggestedEntries?.length ?? 0) > 0) {
		return true;
	}
	return answers.some(
		(answer) =>
			answer.entryId !== undefined &&
			(answer.field === "surface" ||
				answer.field === "commandOrAction" ||
				answer.field === "expect" ||
				answer.field === "notes"),
	);
}

function shouldMergeSpecClarifications(request: AskUserRequest): boolean {
	return request.mode === "specification" || request.mode === "clarify";
}

export default function askUserExtension(api: ExtensionApi): void {
	const askUserTool: AgentTool<
		typeof askUserSchema,
		{
			scopeName: string;
			files: string[];
			answers: AskUserAnswer[];
			validationContract: ReturnType<typeof loadScopeState>["validationContract"];
			specClarifications: ReturnType<typeof loadScopeState>["specClarifications"];
			mu_display: {
				version: 1;
				call: {
					style: "argv";
					text: string;
					command: string;
					argv: string[];
				};
				summary: {
					text: string;
					severity: "ok";
				};
				output: {
					collapse: { maxVisualLines: number; expandHint: string };
					format: "markdown";
				};
			};
		}
	> = {
		name: "ask_user",
		label: "ask_user",
		description:
			"Ask the user focused clarification questions. Use primarily to lock down the validation contract (what to verify and via which surface). You may also use it during problem discovery or for missing specification details. Always keep questions concise and concrete.",
		parameters: askUserSchema,
		getResourceKey: () => `ask_user:${process.env.MU_SESSION_ID ?? "global"}`,
		execute: async (_toolCallId, params: Static<typeof askUserSchema>) => {
			const sessionId = process.env.MU_SESSION_ID ?? null;
			const request: AskUserRequest = {
				mode: params.mode,
				objective: params.objective,
				scopeName: params.scopeName,
				notes: params.notes,
				questions: normalizeQuestions(params.questions),
				suggestedEntries: params.suggestedEntries,
			};

			const currentState = loadScopeState({ sessionId, scopeName: params.scopeName ?? null });
			const promptResult = await promptAskUser({
				...request,
				scopeName: params.scopeName ?? currentState.scopeName ?? undefined,
			});
			const scopeName = sanitizeScopeName(promptResult.scopeName);
			const existingState = loadScopeState({ sessionId, scopeName });

			const validationContract = shouldMergeValidationContract(request, promptResult.answers)
				? mergeValidationContract({
						existing: existingState.validationContract,
						scopeName,
						request,
						answers: promptResult.answers,
					})
				: existingState.validationContract;
			const specClarifications = shouldMergeSpecClarifications(request)
				? mergeSpecClarifications({
						existing: existingState.specClarifications,
						scopeName,
						request,
						answers: promptResult.answers,
					})
				: existingState.specClarifications;

			const files = persistScopeDocuments({
				scopeName,
				sessionId,
				validationContract,
				specClarifications,
			});

			api.appendSessionEntry("ask_user_scope", {
				scopeName,
				mode: request.mode,
				files,
			});

			const summary = formatAskUserSummary(promptResult.answers);
			const content = buildToolContent({
				request,
				scopeName,
				summary,
				files,
			});

			return {
				content: [{ type: "text", text: content }],
				details: {
					scopeName,
					files,
					answers: promptResult.answers,
					validationContract,
					specClarifications,
					mu_display: {
						version: 1 as const,
						call: {
							style: "argv" as const,
							text: `ask_user ${request.mode} ${scopeName}`,
							command: "ask_user",
							argv: [request.mode, scopeName],
						},
						summary: {
							text: `ok · scope=${scopeName} · answers=${promptResult.answers.length}`,
							severity: "ok" as const,
						},
						output: {
							collapse: { maxVisualLines: 8, expandHint: "ctrl+o to expand" },
							format: "markdown" as const,
						},
					},
				},
			};
		},
	};

	api.registerTool(eraseAgentTool(askUserTool), { priority: 150 });

	api.context((messages) => {
		const contextText = buildContextPayload();
		if (!contextText) {
			return messages.filter((message) => !isAskUserContextMessage(message));
		}
		return injectContextMessage(messages, contextText);
	});
}
