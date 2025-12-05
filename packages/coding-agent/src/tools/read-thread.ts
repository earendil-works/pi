import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { SessionManager } from "../session-manager.js";

const readThreadSchema = Type.Object({
	id: Type.String({ description: "The thread ID to read" }),
	projectPath: Type.Optional(
		Type.String({ description: "Path to the project directory where the thread is located" }),
	),
});

export const readThreadTool: AgentTool<typeof readThreadSchema> = {
	name: "read_thread",
	label: "read_thread",
	description: getToolDescription("read_thread"),
	parameters: readThreadSchema,
	execute: async (_toolCallId: string, { id, projectPath }: { id: string; projectPath?: string }) => {
		const mgr = new SessionManager(false, undefined, true, projectPath);
		const content = mgr.getThreadContent(id);

		if (!content) {
			return {
				content: [{ type: "text" as const, text: "Thread not found." }],
				details: undefined,
				isError: true,
			};
		}

		return {
			content: [{ type: "text" as const, text: content }],
			details: undefined,
		};
	},
};
