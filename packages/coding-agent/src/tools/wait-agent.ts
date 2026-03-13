import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { inspectSpawnedAgentSession } from "../spawned-agents.js";

const waitAgentSchema = Type.Object({
	ids: Type.Array(Type.String({ description: "Child session id to wait for." }), {
		minItems: 1,
		description: "One or more spawned child session ids to wait for.",
	}),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Maximum time to wait before returning timed_out results for unfinished children." }),
	),
});

export interface WaitAgentResultItem {
	sessionId: string;
	sessionFile: string;
	status: "completed" | "error" | "aborted" | "timed_out" | "not_found";
	stopReason?: string;
	text?: string;
}

export interface WaitAgentDetails {
	results: WaitAgentResultItem[];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSingleSession(
	sessionId: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<WaitAgentResultItem> {
	for (;;) {
		if (signal?.aborted) {
			return {
				sessionId,
				sessionFile: "",
				status: "timed_out",
			};
		}
		const inspected = inspectSpawnedAgentSession(sessionId);
		if (inspected.status === "completed" || inspected.status === "error" || inspected.status === "aborted") {
			return {
				sessionId: inspected.sessionId,
				sessionFile: inspected.sessionFile,
				status: inspected.status,
				stopReason: inspected.stopReason,
				text: inspected.text,
			};
		}
		if (inspected.status === "not_found") {
			return {
				sessionId: inspected.sessionId,
				sessionFile: inspected.sessionFile,
				status: "not_found",
			};
		}
		if (Date.now() >= deadline) {
			return {
				sessionId,
				sessionFile: inspected.sessionFile,
				status: "timed_out",
			};
		}
		await delay(50);
	}
}

export const waitAgentTool: AgentTool<typeof waitAgentSchema, WaitAgentDetails> = {
	name: "wait_agent",
	label: "wait_agent",
	description: getToolDescription("wait_agent"),
	parameters: waitAgentSchema,
	execute: async (_toolCallId, args: { ids: string[]; timeoutMs?: number }, signal?: AbortSignal) => {
		const timeoutMs = Math.max(1, Math.floor(args.timeoutMs ?? 30_000));
		const deadline = Date.now() + timeoutMs;
		const results = await Promise.all(args.ids.map((sessionId) => waitForSingleSession(sessionId, deadline, signal)));
		const lines = results.map((result) => {
			const header = `${result.sessionId} ${result.status}${result.stopReason ? ` (${result.stopReason})` : ""}`;
			return result.text ? `${header}\n${result.text}` : header;
		});
		return {
			content: [{ type: "text" as const, text: lines.join("\n\n") }],
			details: { results },
		};
	},
};
