import type { DriveOutcome } from "../agent-harness.ts";
import { AbortRequested } from "../execution/effect-gate.ts";
import { SessionInvariantError } from "../session/session.ts";
import { runCheckpoint, startRun } from "./drive/checkpoint.ts";
import { runDeferred } from "./drive/deferred.ts";
import { runGeneration } from "./drive/generation.ts";
import { reconcileOperation } from "./drive/reconcile.ts";
import { recoverAssistantGeneration } from "./drive/recovery.ts";
import {
	commitNavigation,
	recoverStructuralGeneration,
	runStructuralDecision,
	runStructuralGeneration,
	runStructuralRetryWait,
} from "./drive/structural.ts";
import { runTools } from "./drive/tools.ts";
import type { Lane } from "./lane.ts";
import type { Drive, ProcedureResult } from "./types.ts";

function currentOperation<TContext extends object | undefined>(lane: Lane<TContext>, drive: Drive) {
	const operation = lane.state.operation;
	if (operation === null || operation.meta.operationId !== drive.operationId) {
		throw new SessionInvariantError(`Drive ${drive.operationId} has no matching current operation`);
	}
	return operation;
}

/** Drive one installed pass through direct durable procedures until settlement or a durable wait. */
export async function driveOperation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
): Promise<DriveOutcome> {
	let operation = currentOperation(lane, drive);
	if (operation.state.control.status === "running") {
		try {
			await lane.hooks.runWithGate(
				"before_drive",
				{ lane: lane.name, runId: drive.operationId, operation: operation.meta.intent.kind },
				drive.gate,
				drive.context,
			);
		} catch (error) {
			if (!(error instanceof AbortRequested)) throw error;
			await error.cancellation;
		}
	}

	for (;;) {
		operation = currentOperation(lane, drive);
		const state = operation.state;
		let result: ProcedureResult;
		try {
			if (state.control.status === "cancel_requested") {
				result = await reconcileOperation(lane, drive);
			} else
				switch (state.at) {
					case "starting":
						result = await startRun(lane, drive, state);
						break;
					case "checkpoint":
						result = await runCheckpoint(lane, drive, state);
						break;
					case "assistant.ready":
					case "assistant.retry_wait":
						result = await runGeneration(lane, drive, state);
						break;
					case "assistant.effect_pending":
						result = await recoverAssistantGeneration(lane, drive, state);
						break;
					case "tools":
						result = await runTools(lane, drive, state);
						break;
					case "deferred.suspended":
					case "deferred.effect_pending":
						result = await runDeferred(lane, drive, state);
						break;
					case "summary.deciding":
						result = await runStructuralDecision(lane, drive, state);
						break;
					case "summary.ready":
						result = await runStructuralGeneration(lane, drive, state);
						break;
					case "summary.effect_pending":
						result = await recoverStructuralGeneration(lane, drive, state);
						break;
					case "summary.retry_wait":
						result = await runStructuralRetryWait(lane, drive, state);
						break;
					case "navigation.ready_to_commit":
						result = await commitNavigation(lane, drive, state);
						break;
				}
		} catch (error) {
			if (!(error instanceof AbortRequested)) throw error;
			await error.cancellation;
			result = { kind: "continue" };
		}

		if (result.kind === "settled") return { kind: "settled", outcome: result.outcome };
		if (result.kind === "waiting") return result.outcome;
		const next = currentOperation(lane, drive).state;
		if (next === state && next.control.status !== "cancel_requested") {
			throw new SessionInvariantError(`Drive procedure made no progress from ${state.at}`);
		}
	}
}
