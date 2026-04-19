import { type AgentTool, StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { type ProcessEntry, ProcessRegistry, type ProcessStatus, type ProcessType } from "../process-registry.js";
import { getToolDescription } from "../prompts/index.js";
import { inspectSpawnedAgentSession } from "../spawned-agents.js";

const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

const waitAgentSchema = Type.Object({
	ids: Type.Optional(
		Type.Array(Type.String({ description: "Child session id to wait for." }), {
			minItems: 1,
			description: "One or more spawned child session ids to wait for.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Maximum time to wait before returning timed_out results for unfinished children. Defaults to 300000 (5 minutes).",
		}),
	),
	query: Type.Optional(
		Type.Object(
			{
				name: Type.Optional(Type.String({ description: "Filter by process name (supports * and ? globs)." })),
				status: Type.Optional(
					StringEnum(["pending", "running", "completed", "exited", "killed", "failed"] as const, {
						description: "Filter by process status.",
					}),
				),
				type: Type.Optional(
					StringEnum(["worker", "bash", "verifier"] as const, {
						description: "Filter by process type.",
					}),
				),
			},
			{
				description: "Query the process registry by filters. Returns matching entries immediately (no waiting).",
			},
		),
	),
});

export interface WaitAgentResultItem {
	sessionId: string;
	sessionFile: string;
	status: "completed" | "error" | "aborted" | "timed_out" | "not_found";
	stopReason?: string;
	text?: string;
}

export interface WaitAgentWaitDetails {
	results: WaitAgentResultItem[];
}

export interface WaitAgentQueryDetails {
	query: true;
	entries: ProcessEntry[];
}

export type WaitAgentDetails = WaitAgentWaitDetails | WaitAgentQueryDetails;

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
	execute: async (
		_toolCallId: string,
		args: { ids?: string[]; timeoutMs?: number; query?: { name?: string; status?: string; type?: string } },
		signal?: AbortSignal,
	) => {
		const hasIds = args.ids && args.ids.length > 0;
		const hasQuery = !!args.query;

		if (!hasIds && !hasQuery) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: either 'ids' or 'query' must be provided.",
					},
				],
				details: { results: [] },
			};
		}

		if (hasIds && hasQuery) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: 'ids' and 'query' are mutually exclusive. Provide one or the other.",
					},
				],
				details: { results: [] },
			};
		}

		if (hasQuery) {
			const q = args.query!;
			const registry = new ProcessRegistry();
			const filters: { name?: string; status?: ProcessStatus; type?: ProcessType } = {};
			if (q.name) filters.name = q.name;
			if (q.status) filters.status = q.status as ProcessStatus;
			if (q.type) filters.type = q.type as ProcessType;
			const entries = await registry.query(filters);
			const lines = entries.map(
				(e) =>
					`${e.processName} ${e.status} (pid ${e.pid}, type ${e.type})${e.sessionId ? ` session=${e.sessionId}` : ""}${e.exitCode !== undefined ? ` exit=${e.exitCode}` : ""}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: lines.length ? lines.join("\n") : "No matching processes found.",
					},
				],
				details: { query: true as const, entries },
			};
		}

		// ids mode — existing behavior unchanged
		const ids = args.ids!;
		const timeoutMs = Math.max(1, Math.floor(args.timeoutMs ?? DEFAULT_WAIT_AGENT_TIMEOUT_MS));
		const deadline = Date.now() + timeoutMs;
		const results = await Promise.all(ids.map((sessionId) => waitForSingleSession(sessionId, deadline, signal)));
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
