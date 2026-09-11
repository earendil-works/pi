import type { HarnessEvent, LaneSnapshot, LaneWatchEvent } from "../agent-harness.ts";
import type { OperationResultRecord } from "../session/types.ts";

export type LaneSnapshotReduction = "rebase" | undefined;

type LaneOperationSnapshot = NonNullable<LaneSnapshot["operation"]>;

function upsertTool(operation: LaneOperationSnapshot, tool: LaneOperationSnapshot["runningTools"][number]): void {
	const index = operation.runningTools.findIndex((candidate) => candidate.toolCallId === tool.toolCallId);
	if (index === -1) operation.runningTools.push(tool);
	else operation.runningTools[index] = tool;
}

function matchingOperation(
	snapshot: LaneSnapshot,
	operationId: string,
): NonNullable<LaneSnapshot["operation"]> | undefined {
	return snapshot.operation?.id === operationId ? snapshot.operation : undefined;
}

/** Apply one harness event to a mutable lane snapshot. Navigation completion requires a fresh snapshot. */
export function reduceLaneSnapshot(
	snapshot: LaneSnapshot,
	event: HarnessEvent | LaneWatchEvent,
): LaneSnapshotReduction {
	if ("lane" in event && event.lane !== undefined && event.lane !== snapshot.lane && event.type !== "usage") return;
	switch (event.type) {
		case "run_start":
			snapshot.operation = {
				id: event.runId,
				kind: "run",
				startedAt: event.startedAt,
				fromTipId: snapshot.tipId,
				status: "open",
				runningTools: [],
			};
			return;
		case "compaction_start":
			if (snapshot.operation !== null) return;
			snapshot.operation = {
				id: event.runId,
				kind: "compaction",
				startedAt: event.startedAt,
				fromTipId: snapshot.tipId,
				status: "open",
				runningTools: [],
			};
			return;
		case "navigation_start":
			snapshot.operation = {
				id: event.runId,
				kind: "navigation",
				startedAt: event.startedAt,
				fromTipId: snapshot.tipId,
				status: "open",
				runningTools: [],
			};
			return;
		case "operation_abort": {
			const operation = matchingOperation(snapshot, event.operationId);
			if (operation !== undefined) operation.status = "aborting";
			return;
		}
		case "run_resume": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation !== undefined) delete operation.deferred;
			return;
		}
		case "run_suspend": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation === undefined) return;
			delete operation.streamingMessage;
			operation.deferred = { handle: event.deferred, poll: event.poll };
			return;
		}
		case "retry_scheduled": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation !== undefined) {
				operation.retry = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					nextAttemptAt: event.notBefore,
				};
			}
			return;
		}
		case "retry_start":
		case "retry_end": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation !== undefined) delete operation.retry;
			return;
		}
		case "message_start": {
			if (
				event.runId === undefined ||
				event.message.role !== "assistant" ||
				event.message.stopReason !== "pending"
			) {
				return;
			}
			const operation = matchingOperation(snapshot, event.runId);
			if (operation !== undefined) operation.streamingMessage = event.message;
			return;
		}
		case "message_update": {
			if (event.message.role !== "assistant") return;
			const operation = matchingOperation(snapshot, event.runId);
			if (operation !== undefined) operation.streamingMessage = event.message;
			return;
		}
		case "message_end": {
			if (event.runId === undefined) return;
			const operation = matchingOperation(snapshot, event.runId);
			if (operation !== undefined) delete operation.streamingMessage;
			return;
		}
		case "tool_start": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation === undefined) return;
			upsertTool(operation, {
				status: "running",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
			return;
		}
		case "tool_update": {
			const operation = matchingOperation(snapshot, event.runId);
			const tool = operation?.runningTools.find((candidate) => candidate.toolCallId === event.toolCallId);
			if (tool?.status === "running") tool.result = event.partialResult;
			return;
		}
		case "tool_end": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation === undefined) return;
			const index = operation.runningTools.findIndex((candidate) => candidate.toolCallId === event.toolCallId);
			const current = operation.runningTools[index];
			if (current === undefined) return;
			operation.runningTools[index] = {
				status: "settled",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: current.args,
				result: event.result,
				isError: event.isError,
			};
			return;
		}
		case "entry_added": {
			if (event.entry.type === "message" && event.entry.message.role === "toolResult") {
				const operation = snapshot.operation;
				if (operation !== null) {
					const toolCallId = event.entry.message.toolCallId;
					const index = operation.runningTools.findIndex((candidate) => candidate.toolCallId === toolCallId);
					if (index !== -1) operation.runningTools.splice(index, 1);
				}
			}
			if (event.entry.type === "compaction") snapshot.transcript.splice(0, snapshot.transcript.length, event.entry);
			else snapshot.transcript.push(event.entry);
			snapshot.tipId = event.entry.id;
			if (event.entry.type === "message") snapshot.stats.messageCount += 1;
			return;
		}
		case "queue_update":
			snapshot.queues = event.queues;
			return;
		case "usage":
			snapshot.stats.usage = event.totals;
			return;
		case "config_update":
			if (!("lane" in event) || event.lane !== snapshot.lane) return;
			switch (event.property) {
				case "model":
					snapshot.configuration.model = event.value;
					return;
				case "thinkingLevel":
					snapshot.configuration.thinkingLevel = event.value;
					return;
				case "activeTools":
					snapshot.configuration.activeToolNames = event.value;
					return;
			}
			return;
		case "run_end": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation?.kind !== "run") return;
			const record: OperationResultRecord = {
				operationId: event.runId,
				kind: "run",
				status: event.status,
				...(event.status === "failed" ? { error: event.error } : {}),
				fromTipId: event.fromTipId,
				tipId: event.tipId,
				startedAt: operation.startedAt,
				endedAt: event.endedAt,
			};
			snapshot.lastResult = record;
			snapshot.operation = null;
			snapshot.tipId = event.tipId;
			return;
		}
		case "compaction_end": {
			const operation = matchingOperation(snapshot, event.runId);
			if (operation?.kind !== "compaction") return;
			const record: OperationResultRecord = {
				operationId: event.runId,
				kind: "compaction",
				status: event.status,
				...(event.status === "failed" ? { error: event.error } : {}),
				fromTipId: operation.fromTipId,
				tipId: snapshot.tipId,
				startedAt: operation.startedAt,
				endedAt: event.endedAt,
			};
			snapshot.lastResult = record;
			snapshot.operation = null;
			return;
		}
		case "navigation_end":
			return "rebase";
		case "fault":
			snapshot.faulted = true;
			return;
		case "handler_error":
		case "turn_start":
		case "turn_end":
		case "value_update":
		case "lane_created":
			return;
	}
}
