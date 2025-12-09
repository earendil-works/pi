import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { SessionManager } from "../session-manager.js";

const readThreadSchema = Type.Object({
	id: Type.String({ description: "The thread ID to read" }),
	projectPath: Type.Optional(
		Type.String({ description: "Path to the project directory where the thread is located" }),
	),
	max_messages: Type.Optional(Type.Number({ description: "Max messages to return (default: 50)" })),
	start_index: Type.Optional(Type.Number({ description: "Message index to start from (default: 0)" })),
	detailed: Type.Optional(Type.Boolean({ description: "Include tool execution details (default: false)" })),
});

export const readThreadTool: AgentTool<typeof readThreadSchema> = {
	name: "read_thread",
	label: "read_thread",
	description: getToolDescription("read_thread"),
	parameters: readThreadSchema,
	execute: async (
		_toolCallId: string,
		{
			id,
			projectPath,
			max_messages,
			start_index,
			detailed,
		}: {
			id: string;
			projectPath?: string;
			max_messages?: number;
			start_index?: number;
			detailed?: boolean;
		},
	) => {
		const mgr = new SessionManager(false, undefined, true, projectPath);
		const result = mgr.getThreadContent(id, {
			maxMessages: max_messages ?? 50,
			startIndex: start_index ?? 0,
			detailed: detailed ?? false,
		});

		if (!result) {
			return {
				content: [{ type: "text" as const, text: "Thread not found." }],
				details: undefined,
				isError: true,
			};
		}

		const { content, totalMessages, returnedMessages } = result;
		const start = start_index ?? 0;

		// Wrap in XML tags to clearly distinguish from current conversation
		const wrappedContent = `<reference_thread id="${id}" total_messages="${totalMessages}" returned_messages="${returnedMessages}" start_index="${start}">\n${content}\n</reference_thread>`;

		return {
			content: [{ type: "text" as const, text: wrappedContent }],
			details: undefined,
		};
	},
};
