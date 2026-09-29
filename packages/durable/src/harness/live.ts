import type { Draft, JsonRepresentation, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { Transaction } from "../session/transaction.ts";
import type { EntryId, SubmissionId, SubmissionSettlement, TaskId, TaskRecord, Tx } from "../types.ts";
import { convertPartial } from "./generation.ts";
import type { SchedulerOutcome } from "./scheduler.ts";
import type { ToolDiagnostic } from "./types.ts";

/** Presentation of one tool call of the current round. */
export type ToolSlot = {
	callId: string;
	name: string;
	/** Absent for a call its request did not offer; generation wrote its result. */
	taskId?: TaskId;
	status: "pending" | "running" | "done";
	/** Retained running output and what the bounds dropped. */
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	/** Last `details()` value. */
	details?: JsonValue;
	/** Diagnostics recorded through `api.diagnostic()`. */
	diagnostics?: ToolDiagnostic[];
	/** Result entry once done; absent when the tool task faulted or was orphaned. */
	entry?: EntryId;
};

/** Built-in live conversation state: run control and presentation of the current generation and tool round. */
export type LiveState = {
	/** Run control: the task that settles the run's inputs, and those inputs; present exactly while busy. */
	run?: { taskId: TaskId; inputs: SubmissionId[] };
	/** Presentation of the current generation attempt. */
	generation?: {
		attempt: number;
		/** Committed throttled partial of the in-flight response. */
		message?: JsonRepresentation<AssistantMessage>;
		/** Durable backoff before the next attempt. */
		retry?: { at: number; error: string };
		/** Provider-side deferred response being polled. */
		deferred?: { pollAt: number };
	};
	/** The current tool round in call order, from the tool-calling answer until post-tools. */
	tools?: ToolSlot[];
};

export const LiveDoc = defineDoc<LiveState>({
	kind: "pi.live",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	// REMINDER: a complete base whenever nothing runs (spec §8.2): no generation and no running tool slot. That holds
	// while idle, in the commit handing a generation over to its tool round, and between tools, so the delta chain
	// spans at most one generation or the overlapping execution of one round's tools. A slot holds output only while
	// running, so every base is small. Do not add a delta-count bound; the tool output benchmark checks this rule.
	checkpointWhen: (value) =>
		value.generation === undefined && !(value.tools ?? []).some((slot) => slot.status === "running"),
});

/** Built-in task kinds that can own `pi.live.run`. */
const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["pi.generation", "pi.post-tools"]);
const TOOL_TASK_KIND = "pi.tool";

/**
 * End the run owned by `taskId`: settle each of its inputs and remove `run`. Always removes `generation` and `tools`,
 * whose presentation belongs to the ending run.
 */
export function endRun(tx: Tx, live: Draft<LiveState>, taskId: TaskId, settlement: SubmissionSettlement): void {
	if (live.run?.taskId === taskId) {
		for (const id of live.run.inputs) tx.settleSubmission(id, settlement);
		delete live.run;
	}
	delete live.generation;
	delete live.tools;
}

/** The slot of tool task `taskId` in the current round, if the round still lists it. */
export function toolSlot(live: Draft<LiveState>, taskId: TaskId): Draft<ToolSlot> | undefined {
	return live.tools?.find((slot) => slot.taskId === taskId);
}

/** Mark a slot done: the result entry, if any, now carries its running output, details, and diagnostics. */
export function finishSlot(slot: Draft<ToolSlot>, entry: EntryId | undefined): void {
	slot.status = "done";
	if (entry !== undefined) slot.entry = entry;
	clearProgress(slot);
}

/** Remove what a tool published while running; its result entry or a rerun replaces it. */
export function clearProgress(slot: Draft<ToolSlot>): void {
	delete slot.output;
	delete slot.droppedBytes;
	delete slot.droppedLines;
	delete slot.details;
	delete slot.diagnostics;
}

/**
 * Harness cleanup for a terminal outcome the scheduler writes itself (`faulted` or `orphaned`). A run task ends its
 * run; a tool task's slot is marked done without an entry, and context derivation synthesizes the missing result.
 * Ignores other kinds so it never creates `pi.live` elsewhere. The scheduler calls this without knowing task kinds;
 * the Harness passes it in (spec §5.4).
 * REMINDER: a committed generation partial becomes an aborted assistant entry here, exactly as in the generation abort
 * handler, so the transcript keeps what the model produced and `pi.usage` counts its spend. The scheduler's commit has
 * no task scope, so that entry has no `byTaskId`. Faults come from task bugs
 * or malformed provider data (a non-JSON value in a response), or a commit the Storage rejected without effect; an
 * uncertain storage failure poisons the Session instead and writes no outcome.
 */
export async function settleSchedulerOutcome(
	tx: Transaction,
	record: TaskRecord<JsonValue, JsonValue, JsonValue>,
	outcome: SchedulerOutcome,
): Promise<void> {
	if (record.kind === TOOL_TASK_KIND) {
		const slot = toolSlot(await tx.doc(LiveDoc, record.conversationId), record.id);
		if (slot !== undefined) finishSlot(slot, undefined);
		return;
	}
	if (!RUN_TASK_KINDS.has(record.kind)) return;
	const live = await tx.doc(LiveDoc, record.conversationId);
	if (live.run?.taskId !== record.id) return;
	await convertPartial(tx, live, record.conversationId);
	endRun(
		tx,
		live,
		record.id,
		outcome.status === "faulted"
			? { status: "unanswered", reason: "faulted", detail: outcome.error.message }
			: { status: "unanswered", reason: outcome.reason },
	);
}
