import { insertEntry } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type CheckpointOperation,
	type MessageEntry,
	type NewEntry,
	operationScopeOf,
	type StartingOperation,
	type SummaryDecidingOperation,
} from "../../session/types.ts";
import { branchTip, operationPreparation, setValue } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import { chainEntries, committedEntryEvents } from "../transcript.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import {
	assistantReadyAtBoundary,
	type BoundaryFinishPending,
	boundaryPlacementEvents,
	finishRunBoundary,
	planBoundaryInbox,
} from "./boundary.ts";
import { prepareCompactionThreshold } from "./structural.ts";

/** Consume before_run and commit the initial checkpoint. */
export async function startRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: StartingOperation,
): Promise<ProcedureResult> {
	const prompt = await lane.continueOperation(
		run,
		async (_state, _current, meta, reader) => {
			if (meta.intent.kind !== "run") throw new SessionInvariantError("Run operation has non-run intent");
			const entries = await reader.getEntries(meta.intent.promptEntryIds, drive.context);
			const messages = meta.intent.promptEntryIds.map((id) => {
				const entry = entries.get(id);
				if (entry?.type !== "message") {
					throw new SessionInvariantError(`Run prompt entry ${id} is missing its message`);
				}
				return entry.message;
			});
			return { kind: "return", result: messages };
		},
		drive.context,
	);
	if (prompt.kind === "cancel_requested") return { kind: "continue" };

	const hook = await lane.hooks.runWithGate(
		"before_run",
		{ lane: lane.name, runId: drive.operationId, prompt: prompt.value, resources: lane.readConfig().resources },
		drive.gate,
		drive.context,
	);
	const injected = hook?.messages ?? [];
	for (const message of injected) {
		if (message.role === "assistant" && message.stopReason === "pending") {
			throw new SessionInvariantError("before_run returned a pending assistant message");
		}
	}
	const reserved = injected.map((message) => ({ id: lane.session.idGenerator.next(), message }));

	const result = await lane.continueOperation(
		run,
		(state, current) => {
			const entries: NewEntry<MessageEntry>[] = chainEntries(
				state.tipId,
				reserved.map(({ id, message }) => ({ id, type: "message" as const, message })),
			);
			const triggerEntryId = entries.at(-1)?.id ?? state.tipId;
			if (triggerEntryId === null) throw new SessionInvariantError("Run start has no trigger entry");
			const nextState: CheckpointOperation = {
				...operationScopeOf(current),
				at: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId,
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...(entries.length === 0 ? [] : [setValue(branchTip(lane.name), triggerEntryId)]),
				],
				operationState: nextState,
				lane: { tipId: triggerEntryId },
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) => committedEntryEvents(entries, commit, lane.name, drive.operationId),
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

/** Advance one durable run boundary with at most one commit. */
export async function runCheckpoint<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: CheckpointOperation,
): Promise<ProcedureResult> {
	const threshold = await prepareCompactionThreshold(lane, drive, run);
	if (threshold.kind === "cancel_requested") return { kind: "continue" };
	const planned = await lane.continueOperation<CheckpointOperation, ProcedureResult | BoundaryFinishPending>(
		run,
		async (state, current, _meta, reader) => {
			const placement = await planBoundaryInbox(
				lane,
				drive,
				state,
				current,
				reader,
				state.tipId,
				threshold.value === undefined && current.continuation.kind === "may_finish",
			);
			if (placement.triggerEntryId !== undefined) {
				return {
					kind: "commit",
					writes: placement.writes,
					operationState: assistantReadyAtBoundary(lane, state, current, placement.triggerEntryId, false),
					lane: { tipId: placement.tipId, inbox: placement.inbox },
					materialize: () => ({ kind: "continue" }) as const,
					events: (commit) => boundaryPlacementEvents(placement, commit, 0, lane.name, drive.operationId),
				};
			}
			if (threshold.value !== undefined) {
				const structural: SummaryDecidingOperation = {
					...operationScopeOf(current),
					at: "summary.deciding",
					task: {
						taskId: threshold.value.taskId,
						reason: "threshold",
						boundary: {
							kind: "resume_checkpoint",
							resumeAfter: { continuation: current.continuation, triggerEntryId: current.triggerEntryId },
						},
					},
				};
				return {
					kind: "commit",
					writes: [
						...placement.writes,
						setValue(
							operationPreparation(drive.operationId, threshold.value.taskId),
							threshold.value.preparation,
						),
					],
					operationState: structural,
					lane: { tipId: placement.tipId, inbox: placement.inbox },
					materialize: () => ({ kind: "continue" }) as const,
					events: (commit) => [
						...boundaryPlacementEvents(placement, commit, 0, lane.name, drive.operationId),
						{
							type: "compaction_start",
							lane: lane.name,
							runId: drive.operationId,
							reason: "threshold",
							startedAt: commit.timestamp,
						},
					],
				};
			}
			if (current.continuation.kind === "need_assistant") {
				return {
					kind: "commit",
					writes: placement.writes,
					operationState: assistantReadyAtBoundary(
						lane,
						state,
						current,
						current.triggerEntryId,
						current.continuation.overflowRecoveryUsed,
					),
					lane: { tipId: placement.tipId, inbox: placement.inbox },
					materialize: () => ({ kind: "continue" }) as const,
					events: (commit) => boundaryPlacementEvents(placement, commit, 0, lane.name, drive.operationId),
				};
			}
			return {
				kind: "return",
				result: { kind: "finish_pending", entryIds: placement.entries.map((entry) => entry.id) } as const,
			};
		},
		drive.context,
	);
	if (planned.kind === "cancel_requested") return { kind: "continue" };
	if (planned.value.kind !== "finish_pending") return planned.value;
	if (run.continuation.kind !== "may_finish") {
		throw new SessionInvariantError("Checkpoint finish mediation requires a finish continuation");
	}
	return finishRunBoundary(lane, drive, run, run.continuation, planned.value.entryIds);
}
