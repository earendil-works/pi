import { ResetEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type { EntryId, TaskId } from "../types.ts";
import { ConversationConfig } from "./config.ts";
import { GenerationTask, handOver, startRun } from "./generation.ts";
import { applyBoundary, prepareBoundary } from "./inbox.ts";
import { endRun, LiveDoc } from "./live.ts";
import type { ToolTaskResult } from "./tool.ts";
import type { PostToolsHooks, ToolControl } from "./types.ts";

export type PostToolsInput = { assistant: EntryId; tools: TaskId<ToolTaskResult>[] };
export type PostToolsCheckpoint = { phase: "join" };
export type PostToolsResult = Record<string, never>;

/**
 * Built-in post-tools task: runs once every tool task of the round is terminal, applies the round's controls, and either
 * ends the run at the final boundary (`terminate`, `handoff`, or a queued reset) or hands it to the next generation at
 * the `postTools` boundary.
 */
export const PostToolsTask = defineTask<PostToolsInput, PostToolsCheckpoint, PostToolsResult, PostToolsHooks>({
	name: "pi.post-tools",
	version: 1,
	initial: () => ({ phase: "join" }),
	phases: {
		join: async (task, runtime, context) => {
			const { assistant, tools } = task.input;
			const conversationId = runtime.conversationId;
			const controls = new Map<TaskId, ToolControl | undefined>();
			for (const id of tools) {
				const state = (await runtime.getTask(id, context))?.state;
				const outcome = state?.status === "terminal" ? state.outcome : undefined;
				controls.set(id, outcome?.status === "completed" ? outcome.result.control : undefined);
			}
			const slots = (await runtime.snapshot(LiveDoc, conversationId, context))?.tools ?? [];
			const results = slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]));
			await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));
			// Every call of the round, including those answered without a task, must ask to terminate.
			const terminate =
				slots.length > 0 &&
				slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true);
			const added = [...controls.values()].flatMap((control) => control?.addTools ?? []);
			// The last handoff in call order wins.
			const handoff = [...controls.values()].findLast((control) => control?.handoff !== undefined)?.handoff;
			await runtime.commit(async (tx) => {
				const boundary = await prepareBoundary(tx, conversationId);
				if (added.length > 0) {
					const config = await tx.doc(ConversationConfig, conversationId);
					for (const name of added) if (!config.activeTools.includes(name)) config.activeTools.push(name);
				}
				const live = await tx.doc(LiveDoc, conversationId);
				const now = runtime.now();
				if (terminate || handoff !== undefined) {
					if (handoff !== undefined) {
						const message = { role: "user", content: handoff, timestamp: now } as const;
						const entry = await tx.appendEntry(ResetEntry, conversationId, { head: "self", model: [message] });
						boundary.head = entry.id;
					}
					const { users } = await applyBoundary(tx, boundary, "final", now);
					endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
					if (users.length > 0) await startRun(tx, conversationId, live, users);
				} else {
					const { users, reset } = await applyBoundary(tx, boundary, "postTools", now);
					if (reset) {
						// The queued reset cut the run's context before an answer.
						endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
						if (users.length > 0) await startRun(tx, conversationId, live, users);
					} else {
						delete live.tools;
						if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
						handOver(live, runtime.taskId, await tx.createTask(GenerationTask, {}));
					}
				}
				return { status: "terminal", outcome: { status: "completed", result: {} } };
			}, context);
		},
	},
	/** Ends the run; tool tasks still running are not stopped (spec §12). */
	abort: async (_task, runtime, context) => {
		await runtime.commit(async (tx) => {
			endRun(tx, await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId, {
				status: "unanswered",
				reason: "aborted",
			});
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});
