// Model-facing controls for persistent jobs; creation remains explicit async bash.
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { JobManager } from "./manager.ts";
import { JobInfoSchema } from "./state.ts";

const parameters = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("inspect"),
		Type.Literal("logs"),
		Type.Literal("stop"),
		Type.Literal("rename"),
		Type.Literal("restart"),
		Type.Literal("delete"),
	]),
	id: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$", description: "Job ID, required except for list" })),
	all: Type.Optional(Type.Boolean({ description: "List all projects instead of just the current directory" })),
	lines: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 2000,
			description: "Log tail lines (default 200); full logs remain on disk",
		}),
	),
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "New name for rename" })),
	command: Type.Optional(
		Type.String({ description: "Replacement command for restart; otherwise reuse the old command" }),
	),
});

const outputSchema = Type.Object({
	jobs: Type.Optional(Type.Array(JobInfoSchema)),
	job: Type.Optional(JobInfoSchema),
	log: Type.Optional(Type.Object({ text: Type.String(), path: Type.String(), truncated: Type.Boolean() })),
	deleted: Type.Optional(Type.String()),
});

function display(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** Create controls for listing, inspecting, logging, stopping, renaming, restarting and deleting jobs. */
export function createJobsToolDefinition(
	cwd: string,
	manager = new JobManager(),
): ToolDefinition<typeof parameters, { jobId?: string; jobState?: string }> {
	return {
		name: "jobs",
		label: "jobs",
		description:
			"Manage persistent background jobs. Start jobs with bash async:true. List defaults to this project; all:true includes other projects. Inspect checks worker availability. Logs returns a bounded tail and the full log path. Rename changes only the label. Restart stops the old job and starts a new ID, optionally changing its command, using the current environment. Stop active jobs before deleting their records and logs.",
		promptSnippet: "List, inspect, monitor, stop, rename, restart and delete persistent background jobs",
		promptGuidelines: [
			"Use jobs instead of shell process searches to manage pi-owned background jobs. Saved PIDs are informational, not a safe way to identify a process to kill.",
			"A job may be running, completed, failed, stopped, timed_out, lost or unreachable. Unreachable does not mean stopped. Never claim completion from a launch acknowledgment.",
			"Use /jobs to open live job views. Full output is retained at logPath; refine or read that file when a log tail is truncated.",
		],
		parameters,
		outputSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const { action, id } = params;
			if (action === "list") {
				const structuredContent = { jobs: await manager.list(params.all ? undefined : (ctx?.cwd ?? cwd)) };
				return { content: [{ type: "text", text: display(structuredContent) }], details: {}, structuredContent };
			}
			// Trust boundary: the object schema cannot express action-specific required fields.
			if (!id) throw new Error(`jobs ${action} requires id`);
			if (action === "delete") {
				await manager.remove(id);
				return {
					content: [{ type: "text", text: `Deleted job ${id} and its logs` }],
					details: {},
					structuredContent: { deleted: id },
				};
			}
			if (action === "rename" && params.name === undefined) throw new Error("jobs rename requires name");
			const job =
				action === "stop"
					? await manager.stop(id)
					: action === "restart"
						? await manager.restart(id, params.command)
						: action === "rename"
							? await manager.rename(id, params.name!)
							: await manager.inspect(id);
			const structuredContent = { job, ...(action === "logs" ? { log: manager.logs(id, params.lines) } : {}) };
			return {
				content: [{ type: "text", text: display(structuredContent) }],
				details: { jobId: job.id, jobState: job.runtime.state },
				structuredContent,
			};
		},
	};
}
