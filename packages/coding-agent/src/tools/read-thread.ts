import { type AgentTool, completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { findModel, getApiKeyForModel } from "../model-config.js";
import { getToolDescription } from "../prompts/index.js";
import { getCurrentModel } from "../runtime-state.js";
import { SessionManager } from "../session-manager.js";

const readThreadSchema = Type.Object({
	id: Type.String({ description: "The thread ID to read" }),
	goal: Type.Optional(
		Type.String({
			description:
				"The specific information or answer you are looking for in this thread. Required unless raw=true. An AI will read the thread and extract only relevant info.",
		}),
	),
	raw: Type.Optional(
		Type.Boolean({
			description:
				"If true, skip AI extraction and return the raw transcript. Only use when you need the full unfiltered content.",
		}),
	),
	max_messages: Type.Optional(
		Type.Number({ description: "Max messages to return (default: 500 for extraction, 50 for raw mode)" }),
	),
	start_index: Type.Optional(Type.Number({ description: "Message index to start from (default: 0)" })),
	detailed: Type.Optional(
		Type.Boolean({ description: "Include tool execution details in raw mode (default: false)" }),
	),
});

function wrapContent(
	content: string,
	id: string,
	totalMessages: number,
	returnedMessages: number,
	startIndex: number,
	warning?: string,
): string {
	const metadata = `id="${id}" total_messages="${totalMessages}" returned_messages="${returnedMessages}" start_index="${startIndex}"`;
	const warningTag = warning ? `<warning>${warning}</warning>\n` : "";
	return `<reference_thread ${metadata}>\n${warningTag}${content}\n</reference_thread>`;
}

export const readThreadTool: AgentTool<typeof readThreadSchema> = {
	name: "read_thread",
	label: "read_thread",
	description: getToolDescription("read_thread"),
	parameters: readThreadSchema,
	execute: async (
		_toolCallId: string,
		{
			id,
			goal,
			raw,
			max_messages,
			start_index,
			detailed,
		}: {
			id: string;
			goal?: string;
			raw?: boolean;
			max_messages?: number;
			start_index?: number;
			detailed?: boolean;
		},
	) => {
		// Validate: goal is required unless raw mode
		if (!raw && !goal) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: 'goal' parameter is required unless 'raw: true' is set. Please specify what information you're looking for in the thread.",
					},
				],
				details: undefined,
				isError: true,
			};
		}

		const mgr = new SessionManager(false, undefined, true);

		// Raw mode uses lower default limit, extraction mode uses higher
		const limit = max_messages ?? (raw ? 50 : 500);
		const start = start_index ?? 0;

		const result = mgr.getThreadContent(id, {
			maxMessages: limit,
			startIndex: start,
			detailed: detailed ?? false,
		});

		if (!result) {
			return {
				content: [{ type: "text" as const, text: "Thread not found." }],
				details: undefined,
				isError: true,
			};
		}

		// Raw Mode: Return transcript without AI extraction
		if (raw) {
			const wrappedContent = wrapContent(result.content, id, result.totalMessages, result.returnedMessages, start);
			return {
				content: [{ type: "text" as const, text: wrappedContent }],
				details: undefined,
			};
		}

		// Extraction Mode: Use AI to extract relevant information
		{
			const currentModel = getCurrentModel();
			let extractionModel = currentModel;

			// Prefer Sonnet 4.5 if user is on Anthropic
			if (currentModel?.provider === "anthropic") {
				const found = findModel("anthropic", "claude-sonnet-4-5");
				if (found?.model) extractionModel = found.model;
			}

			// Fallback to raw if no model available (should be rare)
			if (!extractionModel) {
				const raw = wrapContent(
					result.content,
					id,
					result.totalMessages,
					result.returnedMessages,
					start,
					"No active model available for extraction. Returning raw content.",
				);
				return { content: [{ type: "text", text: raw }], details: undefined };
			}

			// Truncate to ~400k characters (approx 100k tokens) for safety
			const MAX_CHARS = 400000;
			const contentToProcess =
				result.content.length > MAX_CHARS
					? result.content.slice(0, MAX_CHARS) + "\n...[content truncated due to length]..."
					: result.content;

			// Get API key or OAuth token for the extraction model
			const apiKey = await getApiKeyForModel(extractionModel);
			if (!apiKey) {
				const raw = wrapContent(
					result.content,
					id,
					result.totalMessages,
					result.returnedMessages,
					start,
					`No API key or OAuth token available for ${extractionModel.provider}. Returning raw content.`,
				);
				return { content: [{ type: "text", text: raw }], details: undefined };
			}

			try {
				const extraction = await completeSimple(
					extractionModel,
					{
						systemPrompt:
							"You are an expert researcher. Extract information relevant to the user's goal from the provided conversation transcript.\n" +
							"- Quote key decisions, file paths, or code snippets.\n" +
							"- Summarize context if needed.\n" +
							"- If the info is not found, state that clearly.\n" +
							"- Be concise.",
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: `Transcript:\n${contentToProcess}\n\nGoal: ${goal}` }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey },
				);

				const extractedText = extraction.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("");

				return {
					content: [
						{
							type: "text",
							text: `<thread_extract goal="${goal}" source_thread="${id}">\n${extractedText}\n</thread_extract>`,
						},
					],
					details: undefined,
				};
			} catch (error: unknown) {
				// Fallback to raw content on failure
				const errorMessage = error instanceof Error ? error.message : String(error);
				const raw = wrapContent(
					result.content,
					id,
					result.totalMessages,
					result.returnedMessages,
					start,
					`Extraction failed: ${errorMessage}. Returning raw content.`,
				);
				return { content: [{ type: "text", text: raw }], details: undefined };
			}
		}
	},
};
