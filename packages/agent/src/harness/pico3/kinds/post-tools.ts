import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { type CoreKind, type HookInfo, type Id, type Stored, toStored } from "../types.ts";
import type { ToolTaskResult } from "./tool.ts";

export type PostToolsInput = { inputs: Id[]; assistant: Id; tools: Id[] };
export type PostToolsResult = { successor?: Id; ended?: "terminate" | "handoff" };
export interface PostToolsHooks {
	afterTools(assistant: Id, results: Id[], info: HookInfo, ctx: Context): void | Promise<void>;
}
export const postToolsConfig = {
	sticky: {
		steeringMode: "one-at-a-time" as "all" | "one-at-a-time",
		followUpMode: "one-at-a-time" as "all" | "one-at-a-time",
	},
} as const;

export const postTools: CoreKind<
	PostToolsInput,
	never,
	PostToolsResult,
	never,
	null,
	PostToolsHooks,
	typeof postToolsConfig
> = {
	name: "pi.post_tools",
	turn: true,
	config: postToolsConfig,
	phases: {},

	async initial(task, rt, ctx) {
		const rows = await rt.commit(async (tx) => {
			const assistant = await tx.entry(task.input.assistant);
			const calls = ((assistant?.model?.[0] as Stored<AssistantMessage> | undefined)?.content ?? []).filter(
				(content): content is Stored<ToolCall> => content.type === "toolCall",
			);
			return Promise.all(
				task.input.tools.map(async (id, index) => {
					const toolTask = (await tx.task(id))!;
					const call = calls[index]!;
					if (toolTask.outcome?.status === "completed") {
						const result = toolTask.outcome.result as ToolTaskResult;
						return {
							call,
							entry: result.entry as Id | undefined,
							control: result.control,
							missing: undefined as "orphaned" | "aborted" | undefined,
						};
					}
					if (toolTask.outcome?.status === "aborted") {
						const aborted = toolTask.outcome.result as { entry?: Id };
						return {
							call,
							entry: aborted.entry,
							control: undefined,
							missing: aborted.entry === undefined ? ("aborted" as const) : undefined,
						};
					}
					return { call, entry: undefined, control: undefined, missing: "orphaned" as const };
				}),
			);
		}, ctx);
		const results = rows.map((row) => row.entry).filter((entry): entry is Id => entry !== undefined);
		await rt.hooks.each(ctx, (hook, api) => hook.afterTools?.(task.input.assistant, results, api, ctx));

		return {
			done: async (tx, current) => {
				const conversationId = current.conversationId;
				const head = await tx.newestEntry(conversationId, { withHead: true });
				const state = tx.rewindable(conversationId);
				const selectedTools = [...state.selectedTools];
				let terminate = false;
				let handoff: string | undefined;
				for (const row of rows) {
					for (const name of row.control?.addTools ?? [])
						if (!selectedTools.includes(name)) selectedTools.push(name);
					if (row.control?.terminate) terminate = true;
					if (row.control?.handoff !== undefined) handoff = row.control.handoff;
				}
				if (selectedTools.length !== state.selectedTools.length) {
					state.selectedTools = selectedTools;
					tx.emit({ type: "config.changed", keys: ["selectedTools"] });
				}
				for (const row of rows) {
					if (row.missing === undefined) continue;
					tx.appendEntry(conversationId, {
						kind: "pi.tool_result",
						model: [
							toStored({
								role: "toolResult" as const,
								toolCallId: row.call.id,
								toolName: row.call.name,
								content: [{ type: "text" as const, text: `Tool result unavailable: task ${row.missing}.` }],
								isError: true,
								timestamp: rt.now(),
							}),
						],
						data: { diagnostics: [{ severity: "error", message: row.missing, code: row.missing }] },
					});
					tx.emit({
						type: "warning",
						source: "post_tools",
						message: `synthesized ${row.missing} tool result for ${row.call.id}`,
					});
				}
				let headBoundary = head?.id;
				if (handoff !== undefined) {
					headBoundary = tx.appendEntry(conversationId, {
						kind: "pi.handoff",
						head: "self",
						model: [{ role: "user", content: handoff, timestamp: rt.now() }],
					});
				}
				if (handoff !== undefined || terminate) {
					tx.sticky(conversationId).turn = { tools: [] };
					await tx.resolveInputs(task.input.inputs, { status: "done", answer: task.input.assistant });
					tx.emit({ type: "turn.ended", inputs: task.input.inputs, status: "done", answer: task.input.assistant });
					const { triggers } = await tx.boundary(conversationId, "final", headBoundary);
					if (triggers.length > 0) tx.emit({ type: "turn.started", inputs: triggers });
					const ended = handoff !== undefined ? "handoff" : "terminate";
					return {
						status: "completed",
						result:
							triggers.length > 0
								? { ended, successor: tx.createTask({ kind: "pi.generation", input: { inputs: triggers } }) }
								: { ended },
					};
				}
				const { triggers, terminated } = await tx.boundary(conversationId, "postTools", headBoundary);
				if (terminated) {
					tx.sticky(conversationId).turn = { tools: [] };
					await tx.resolveInputs(task.input.inputs, { status: "unanswered", reason: "terminated" });
					tx.emit({ type: "turn.ended", inputs: task.input.inputs, status: "unanswered", reason: "terminated" });
					if (triggers.length > 0) tx.emit({ type: "turn.started", inputs: triggers });
					return {
						status: "completed",
						result:
							triggers.length > 0
								? { successor: tx.createTask({ kind: "pi.generation", input: { inputs: triggers } }) }
								: {},
					};
				}
				return {
					status: "completed",
					result: {
						successor: tx.createTask({
							kind: "pi.generation",
							input: { inputs: [...task.input.inputs, ...triggers] },
						}),
					},
				};
			},
		};
	},

	async abort(task) {
		return async (tx, current) => {
			tx.sticky(current.conversationId).turn = { tools: [] };
			await tx.resolveInputs(task.input.inputs, { status: "unanswered", reason: "aborted" });
			tx.emit({ type: "turn.ended", inputs: task.input.inputs, status: "unanswered", reason: "aborted" });
			return null;
		};
	},
};
