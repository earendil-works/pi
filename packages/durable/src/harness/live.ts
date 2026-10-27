import type { Draft, JsonRepresentation, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	CommitOptions,
	EntryId,
	JsonObject,
	SubmissionId,
	SubmissionSettlement,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { convertPartial } from "./generation.ts";
import type { SchedulerOutcome } from "./scheduler.ts";
import type { CompactionReason, CompactionResult, ToolDiagnostic } from "./types.ts";

/** What a running tool call publishes, shared by model-issued and nested calls. */
type SlotProgress = {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	/** Retained running output and what the bounds dropped. */
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	/** Last `details()` value. */
	details?: JsonValue;
	/** Diagnostics recorded through `api.diagnostic()`. */
	diagnostics?: ToolDiagnostic[];
};

/** Presentation of one tool call of the current round. */
export type ToolSlot = SlotProgress & {
	/**
	 * Absent for a call not started yet (sequential round) and for a call its request did not offer, which starts `done`
	 * with the `entry` generation wrote.
	 */
	taskId?: TaskId;
	/** Result entry once done; absent when the tool task faulted or was orphaned. */
	entry?: EntryId;
};

/**
 * Presentation of one nested call: a call a running tool made through `executeTool()`. `callId` is
 * `<parentCallId>/<key>`, the call's ID in tool events and unique because keys contain no `/`. The Harness relates
 * slots by task ID: `taskId` is the call's tool task, `parentTaskId` the calling one, model-issued or nested.
 */
export type NestedToolSlot = SlotProgress & {
	parentCallId: string;
	parentTaskId: TaskId;
	taskId: TaskId;
	/**
	 * What the call was made with, replaced by the arguments it runs with, after repair, `beforeTool`, and coercion,
	 * once it starts executing. A model-issued call's arguments are in its assistant entry instead.
	 */
	arguments: JsonObject;
	/** Once done: how the call ended, for a status line. The result itself is in the caller's `NestedCallDoc`. */
	summary?: NestedToolSummary;
};

/** How a nested call ended: an error flag, its execution time, its spend, and up to 500 characters of error text. */
export type NestedToolSummary = {
	isError: boolean;
	durationMs?: number;
	usage?: JsonRepresentation<Usage>;
	error?: string;
};

/** Presentation of one live compaction task (spec §8.7). */
export type CompactionStatus = {
	taskId: TaskId<CompactionResult>;
	reason: CompactionReason;
	/** Whether a generation waits for it: a compaction the generation owns. */
	blocking: boolean;
	attempt: number;
	/** Durable backoff before the next summarization attempt. */
	retry?: { at: number; error: string };
};

/** The newest compaction that failed since a compaction last produced a summary (spec §8.7). */
export type CompactionFailure = {
	taskId: TaskId<CompactionResult>;
	reason: CompactionReason;
	/** The failed or faulted outcome's error message, or why the scheduler orphaned the task. */
	error: string;
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
	/** The current tool round in call order, from the tool-calling answer until the generation's `tools` phase ends it. */
	tools?: ToolSlot[];
	/**
	 * Nested calls of running tool calls, in creation order, so a parent precedes its children and task IDs ascend. A
	 * call's nested slots are removed when the call settles.
	 */
	nestedTools?: NestedToolSlot[];
	/** Live compaction tasks in task ID order; absent when none. */
	compactions?: CompactionStatus[];
	/**
	 * The newest compaction failure, so a client can show it after the task ended. A compaction that produces a summary
	 * removes it; one that is aborted or finds nothing to compact leaves it.
	 */
	compactionFailure?: CompactionFailure;
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
	// running, so every base is small; a nested call's result lives in its caller's task documents, never here. Do not
	// add a delta-count bound; the tool output benchmark checks this rule.
	checkpointWhen: (value) =>
		value.generation === undefined &&
		!(value.tools ?? []).some((slot) => slot.status === "running") &&
		!(value.nestedTools ?? []).some((slot) => slot.status === "running"),
});

/**
 * How the progress throttles commit a partial answer and running tool output into `pi.live`: deferred, so storage gets
 * them together, at the next commit that reads or writes `pi.live` or after `settings.progress.persistWithinMs`. Every
 * commit that consumes or clears streamed fields reads `pi.live`, so it stores them with its own changes (spec §8.2).
 */
export const PROGRESS_COMMIT: CommitOptions = { persistence: { kind: "deferred" } };

/** Built-in task kinds that can own `pi.live.run`. */
const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["pi.generation"]);
const TOOL_TASK_KIND = "pi.tool";
const COMPACTION_TASK_KIND = "pi.compaction";

/**
 * End the run owned by `taskId`: settle each of its inputs and remove `run`. Always removes `generation`, `tools`, and
 * `nestedTools`, whose presentation belongs to the ending run.
 */
export function endRun(tx: Tx, live: Draft<LiveState>, taskId: TaskId, settlement: SubmissionSettlement): void {
	if (live.run?.taskId === taskId) {
		for (const id of live.run.inputs) tx.settleSubmission(id, settlement);
		delete live.run;
	}
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
}

/** Add the status of a compaction task created in this commit; statuses stay in task ID order. */
export function addCompactionStatus(live: Draft<LiveState>, status: CompactionStatus): void {
	live.compactions ??= [];
	live.compactions.push(status);
}

/** The status of compaction task `taskId`, if listed. */
export function compactionStatus(live: Draft<LiveState>, taskId: TaskId): Draft<CompactionStatus> | undefined {
	return live.compactions?.find((status) => status.taskId === taskId);
}

/** Remove the status of compaction task `taskId`, and the list once empty. */
export function removeCompactionStatus(live: Draft<LiveState>, taskId: TaskId): void {
	const statuses = live.compactions;
	if (statuses === undefined) return;
	const index = statuses.findIndex((status) => status.taskId === taskId);
	if (index >= 0) statuses.splice(index, 1);
	if (statuses.length === 0) delete live.compactions;
}

/** Remove the status of compaction task `taskId` and record that it failed with `error`. */
export function failCompactionStatus(live: Draft<LiveState>, taskId: TaskId, error: string): void {
	const status = compactionStatus(live, taskId);
	if (status !== undefined) live.compactionFailure = { taskId: status.taskId, reason: status.reason, error };
	removeCompactionStatus(live, taskId);
}

/**
 * The slot of tool task `taskId`, model-issued or nested, if `pi.live` still lists it. Nested slots are found by binary
 * search: a tool may make thousands of nested calls, each of which looks up its slot in several commits, and every
 * element a search reads costs a node in the draft's change tracker. Their task IDs ascend: each slot is appended in
 * the commit that creates its task, task IDs ascend in commit order, and removal keeps the order.
 */
export function toolSlot(live: Draft<LiveState>, taskId: TaskId): Draft<ToolSlot | NestedToolSlot> | undefined {
	const slot = live.tools?.find((each) => each.taskId === taskId);
	if (slot !== undefined || live.nestedTools === undefined) return slot;
	const nested = live.nestedTools;
	let low = 0;
	let high = nested.length - 1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const candidate = nested[middle]!;
		if (candidate.taskId === taskId) return candidate;
		if (candidate.taskId < taskId) low = middle + 1;
		else high = middle - 1;
	}
	return undefined;
}

/**
 * Mark a slot done and clear its running output; the caller sets a model-issued call's result `entry`, or a nested
 * call's `summary`. Neither is set when the task faulted or was orphaned.
 */
export function finishSlot(slot: Draft<ToolSlot | NestedToolSlot>): void {
	slot.status = "done";
	clearProgress(slot);
}

/** Remove the nested slots below tool task `taskId`, transitively; the list holds parents before their children. */
export function removeNestedSlots(live: Draft<LiveState>, taskId: TaskId): void {
	const nested = live.nestedTools;
	if (nested === undefined) return;
	const removed = new Set<TaskId>([taskId]);
	for (const slot of nested) if (removed.has(slot.parentTaskId)) removed.add(slot.taskId);
	for (let index = nested.length - 1; index >= 0; index--) {
		if (removed.has(nested[index]!.parentTaskId)) nested.splice(index, 1);
	}
	if (nested.length === 0) delete live.nestedTools;
}

/** Remove what a tool published while running; its result entry or a rerun replaces it. */
export function clearProgress(slot: Draft<SlotProgress>): void {
	delete slot.output;
	delete slot.droppedBytes;
	delete slot.droppedLines;
	delete slot.details;
	delete slot.diagnostics;
}

/**
 * Harness cleanup for a terminal outcome the scheduler writes itself (`faulted` or `orphaned`). A run task ends its
 * run; a tool task's slot is marked done without an entry, and context derivation synthesizes the missing result; a
 * compaction task's status is removed and its failure recorded.
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
		const live = await tx.doc(LiveDoc, record.conversationId);
		const slot = toolSlot(live, record.id);
		if (slot !== undefined) finishSlot(slot);
		removeNestedSlots(live, record.id);
		return;
	}
	if (record.kind === COMPACTION_TASK_KIND) {
		const error = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
		failCompactionStatus(await tx.doc(LiveDoc, record.conversationId), record.id, error);
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
