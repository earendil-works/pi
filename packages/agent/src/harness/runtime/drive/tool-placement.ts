import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentToolCall } from "../../../types.ts";
import type { HarnessEvent } from "../../agent-harness.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type CheckpointOperation,
	type MessageEntry,
	type NewEntry,
	type OperationState,
	operationScopeOf,
	type ToolBatch,
	type ToolCall,
	type ToolsOperation,
	type UsageRow,
	type Write,
} from "../../session/types.ts";
import {
	branchTip,
	deleteValue,
	laneConfig,
	operationToolArgsPrefix,
	pendingEntry,
	setValue,
} from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import type { Drive } from "../types.ts";

export type ToolBatchSource = {
	assistant: AssistantMessage;
	calls: Map<number, AgentToolCall>;
};

export async function readToolBatchSource<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
): Promise<ToolBatchSource> {
	return lane.command<ToolBatchSource>(async (_state, reader) => {
		const entry = (await reader.getEntries([batch.assistantEntryId], drive.context)).get(batch.assistantEntryId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new SessionInvariantError("Tool batch assistant entry is invalid");
		}
		const calls = new Map<number, AgentToolCall>();
		for (const call of batch.calls) {
			const block = entry.message.content[call.sourceIndex];
			if (block?.type !== "toolCall") {
				throw new SessionInvariantError(
					`Tool call source index ${call.sourceIndex} does not name a tool-call block`,
				);
			}
			calls.set(call.sourceIndex, block);
		}
		return { kind: "return", result: { assistant: entry.message, calls } };
	}, drive.context);
}

type PlacementItem = {
	call: Extract<ToolCall, { status: "outcome_ready" }>;
	message: ToolResultMessage<unknown>;
};

type PlacementRead = {
	items: PlacementItem[];
	turnResults?: ToolResultMessage<unknown>[];
};

function isToolResultMessage(value: unknown): value is ToolResultMessage<unknown> {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

export function toolCallFor(sources: ToolBatchSource, call: ToolCall): AgentToolCall {
	const source = sources.calls.get(call.sourceIndex);
	if (source === undefined) {
		throw new SessionInvariantError(`Tool call source index ${call.sourceIndex} is invalid`);
	}
	return source;
}

export function withToolBatch(run: ToolsOperation, batch: ToolBatch): ToolsOperation {
	return { ...operationScopeOf(run), at: "tools", batch };
}

async function readPlacement<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	sources: ToolBatchSource,
): Promise<PlacementRead | undefined> {
	return lane.command<PlacementRead | undefined>(async (state, reader) => {
		const operation = state.operation;
		if (operation?.state.at !== "tools") return { kind: "return", result: undefined };
		const current = operation.state.batch;
		let first = current.calls.findIndex((call) => call.status !== "completed");
		if (first === -1) return { kind: "return", result: undefined };
		const ready: Array<Extract<ToolCall, { status: "outcome_ready" }>> = [];
		while (first < current.calls.length) {
			const call = current.calls[first]!;
			if (call.status !== "outcome_ready") break;
			ready.push(call);
			first += 1;
		}
		if (ready.length === 0) return { kind: "return", result: undefined };

		const items: PlacementItem[] = [];
		for (const call of ready) {
			const stored = await reader.getValue(pendingEntry(call.resultEntryId), drive.context);
			if (stored?.value.type !== "message" || !isToolResultMessage(stored.value.payload)) {
				throw new SessionInvariantError(`Tool call ${call.resultEntryId} is missing its staged result`);
			}
			const source = toolCallFor(sources, call);
			if (stored.value.payload.toolCallId !== source.id || stored.value.payload.toolName !== source.name) {
				throw new SessionInvariantError(`Tool call ${call.resultEntryId} has a mismatched staged result`);
			}
			items.push({ call, message: stored.value.payload });
		}

		let turnResults: ToolResultMessage<unknown>[] | undefined;
		if (first === current.calls.length) {
			const placedIds = current.calls
				.filter((call) => call.status === "completed")
				.map((call) => call.resultEntryId);
			const placed = await reader.getEntries(placedIds, drive.context);
			const staged = new Map(items.map((item) => [item.call.resultEntryId, item.message]));
			turnResults = current.calls.map((call) => {
				const message =
					staged.get(call.resultEntryId) ??
					(() => {
						const entry = placed.get(call.resultEntryId);
						return entry?.type === "message" && isToolResultMessage(entry.message) ? entry.message : undefined;
					})();
				if (message === undefined) {
					throw new SessionInvariantError(`Completed tool call ${call.resultEntryId} is missing its result entry`);
				}
				return message;
			});
		}
		return {
			kind: "return",
			result: { items, ...(turnResults === undefined ? {} : { turnResults }) },
		};
	}, drive.context);
}

async function commitPlacement<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: ToolsOperation,
	read: PlacementRead,
): Promise<boolean> {
	const usageIds = read.items.map((item) =>
		item.message.usage === undefined ? undefined : lane.session.idGenerator.next(),
	);
	return lane.settleOperation<ToolsOperation, boolean>(
		capability,
		async (state, run, _meta, reader) => {
			const current = run.batch;
			const writes: Write[] = [];
			const eventEntries: Array<{ entry: NewEntry<MessageEntry>; seqIndex: number }> = [];
			const eventUsage: Array<{ row: Omit<UsageRow, "seq">; seqIndex: number }> = [];
			let parentId = state.tipId;
			for (const [index, item] of read.items.entries()) {
				const entry: NewEntry<MessageEntry> = {
					id: item.call.resultEntryId,
					parentId,
					type: "message",
					message: item.message,
					...(item.call.terminate ? { terminate: true } : {}),
				};
				eventEntries.push({ entry, seqIndex: writes.length });
				writes.push(insertEntry(entry), deleteValue(pendingEntry(item.call.resultEntryId)));
				const usageId = usageIds[index];
				if (usageId !== undefined && item.message.usage !== undefined) {
					const row: Omit<UsageRow, "seq"> = {
						id: usageId,
						usage: item.message.usage,
						entryId: item.call.resultEntryId,
						adjustment: false,
					};
					eventUsage.push({ row, seqIndex: writes.length });
					writes.push(insertUsage(row));
				}
				parentId = item.call.resultEntryId;
			}

			const completedCalls = current.calls.map((call) => {
				const item = read.items.find(
					(candidate) =>
						candidate.call.sourceIndex === call.sourceIndex &&
						candidate.call.resultEntryId === call.resultEntryId,
				);
				return item === undefined
					? call
					: {
							status: "completed" as const,
							sourceIndex: call.sourceIndex,
							resultEntryId: call.resultEntryId,
							terminate: item.call.terminate,
						};
			});
			const complete = completedCalls.every((call) => call.status === "completed");
			let nextConfiguration = state.configuration;
			const addedNames: string[] = [];
			for (const item of read.items) {
				for (const name of item.message.addedToolNames ?? []) {
					if (!nextConfiguration.activeToolNames.includes(name) && !addedNames.includes(name)) {
						addedNames.push(name);
					}
				}
			}
			if (addedNames.length !== 0) {
				nextConfiguration = {
					...nextConfiguration,
					activeToolNames: [...nextConfiguration.activeToolNames, ...addedNames],
				};
				writes.push(setValue(laneConfig(lane.name), nextConfiguration));
			}
			writes.push(setValue(branchTip(lane.name), parentId));

			let nextRun: OperationState;
			if (complete) {
				const allTerminate = completedCalls.every((call) => call.status === "completed" && call.terminate);
				const checkpoint: CheckpointOperation = {
					...operationScopeOf(run),
					at: "checkpoint",
					continuation: allTerminate
						? { kind: "may_finish", includeFinalAssistant: false }
						: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: parentId!,
				};
				nextRun = checkpoint;
				const args = await reader.scanValues(
					operationToolArgsPrefix(drive.operationId, capability.batch.turnId),
					drive.context,
				);
				writes.push(...args.map(({ address }) => deleteValue(address)));
			} else {
				nextRun = withToolBatch(run, { ...current, calls: completedCalls });
			}
			return {
				kind: "commit",
				writes,
				operationState: nextRun,
				lane: { tipId: parentId, configuration: nextConfiguration },
				materialize: () => complete,
				events: (commit) => {
					const events: HarnessEvent[] = [];
					for (const { entry, seqIndex } of eventEntries) {
						events.push({
							type: "entry_added",
							lane: lane.name,
							entry: { ...entry, seq: commit.seqs[seqIndex]!, timestamp: commit.timestamp },
						});
						const usage = eventUsage.find((candidate) => candidate.row.entryId === entry.id);
						if (usage !== undefined) {
							events.push({
								type: "usage",
								lane: lane.name,
								row: { ...usage.row, seq: commit.seqs[usage.seqIndex]! },
								totals: commit.stats.usage,
							});
						}
					}
					if (addedNames.length !== 0) {
						events.push({
							type: "config_update",
							lane: lane.name,
							property: "activeTools",
							previous: state.configuration.activeToolNames,
							value: nextConfiguration.activeToolNames,
						});
					}
					return events;
				},
			};
		},
		drive.context,
	);
}

export async function materializeReady<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: ToolsOperation,
	sources: ToolBatchSource,
	recovery: boolean,
): Promise<void> {
	const read = await readPlacement(lane, drive, sources);
	if (read === undefined) return;
	await lane.emitBatch(
		read.items.flatMap(({ call, message }) => [
			{
				type: "message_start" as const,
				lane: lane.name,
				runId: drive.operationId,
				message,
				...(recovery ? { recovery: true as const } : {}),
			},
			{
				type: "message_end" as const,
				lane: lane.name,
				runId: drive.operationId,
				message,
				entryId: call.resultEntryId,
				...(recovery ? { recovery: true as const } : {}),
			},
		]),
		drive.context,
	);
	const complete = await commitPlacement(lane, drive, capability, read);
	if (complete && read.turnResults !== undefined) {
		await lane.emitBatch(
			[
				{
					type: "turn_end",
					lane: lane.name,
					runId: drive.operationId,
					turnId: capability.batch.turnId,
					message: sources.assistant,
					toolResults: read.turnResults,
					...(recovery ? { recovery: true as const } : {}),
				},
			],
			drive.context,
		);
	}
}
