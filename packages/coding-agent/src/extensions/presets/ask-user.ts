import type { AgentTool } from "@kennyfrc/mu-ai";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { promptAskUser } from "../ask-user/interaction.js";
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
	notes: Type.Optional(Type.String()),
	questions: Type.Array(QUESTION_SCHEMA, { minItems: 1, maxItems: 6 }),
});

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

function buildToolContent(args: { request: AskUserRequest; summary: string }): string {
	const lines = [`Mode: ${args.request.mode}`, "", args.summary.trim() || "No answers captured."];
	return lines.join("\n");
}

export default function askUserExtension(api: ExtensionApi): void {
	const askUserTool: AgentTool<
		typeof askUserSchema,
		{
			answers: AskUserAnswer[];
			projection: {
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
			"Ask the user focused clarification questions. Use this before finalizing a response when validation-contract, specification, or problem-discovery details are materially ambiguous. Valid `mode` values are exactly `validation_contract`, `specification`, and `clarify` — never invent other mode strings. Use `specification` for architecture, design, planning, boundaries, abstractions, and tradeoff lock-in. Use `validation_contract` for deciding what to verify, how to verify it, and on which surface. Use `clarify` for other missing facts that materially affect correctness. Keep questions concise and concrete, prefer 1-4 questions, and always leave room for a manual free-text answer from the user. Each question should have a short stable `id`, a short `topic`, and optional `options`; set `allowCustom: true` whenever the user may need to type their own answer.",
		parameters: askUserSchema,
		getResourceKey: () => `ask_user:${process.env.MU_SESSION_ID ?? "global"}`,
		execute: async (_toolCallId, params: Static<typeof askUserSchema>) => {
			const request: AskUserRequest = {
				mode: params.mode,
				objective: params.objective,
				notes: params.notes,
				questions: normalizeQuestions(params.questions),
			};

			const result = await promptAskUser(request);

			const summary = result.summary;
			const content = buildToolContent({
				request,
				summary,
			});

			return {
				content: [{ type: "text", text: content }],
				details: {
					answers: result.answers,
					projection: {
						version: 1 as const,
						call: {
							style: "argv" as const,
							text: `ask_user ${request.mode}`,
							command: "ask_user",
							argv: [request.mode],
						},
						summary: {
							text: `ok · answers=${result.answers.length}`,
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
}
