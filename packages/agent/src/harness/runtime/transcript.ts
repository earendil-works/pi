import type { AgentMessage } from "../../types.ts";
import type { HarnessEvent, LaneQueuedItem } from "../agent-harness.ts";
import type { Context } from "../context.ts";
import { materializeCommittedEntry } from "../session/commit.ts";
import { buildSessionContext } from "../session/context.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { CommitResult, Entry, InboxItem, NewEntry, OperationState, SessionReader } from "../session/types.ts";
import { pendingEntry } from "../session/values.ts";
import type { Lane } from "./lane.ts";
import type { ContinueOperationResult, Drive } from "./types.ts";

export function chainEntries<T extends { id: string }>(
	parentId: string | null,
	items: readonly T[],
): Array<T & { parentId: string | null }> {
	return items.map((item) => {
		const entry = { ...item, parentId };
		parentId = item.id;
		return entry;
	});
}

export function entryLifecycleEvents(entry: Entry, lane: string, runId?: string): HarnessEvent[] {
	const operation = runId === undefined ? {} : { runId };
	return entry.type === "message"
		? [
				{ type: "message_start", lane, ...operation, message: entry.message },
				{ type: "message_end", lane, ...operation, message: entry.message, entryId: entry.id },
				{ type: "entry_added", lane, entry },
			]
		: [{ type: "entry_added", lane, entry }];
}

export function committedEntryEvents(
	entries: readonly NewEntry[],
	commit: CommitResult,
	lane: string,
	runId?: string,
	firstWriteIndex = 0,
): HarnessEvent[] {
	return entries.flatMap((entry, index) =>
		entryLifecycleEvents(
			materializeCommittedEntry(entry, commit.seqs[firstWriteIndex + index]!, commit.timestamp),
			lane,
			runId,
		),
	);
}

export function readBoundedEntries<TContext extends object | undefined, TState extends OperationState>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: TState,
): Promise<ContinueOperationResult<Entry[]>> {
	return lane.continueOperation(
		capability,
		async (state, _current, _meta, reader) => {
			if (state.tipId === null) throw new SessionInvariantError("Run operation has no Branch tip");
			const entries = await reader.scanBranch(
				{ start: state.tipId, stopAtType: "compaction", order: "newestFirst" },
				drive.context,
			);
			return { kind: "return", result: entries.reverse() };
		},
		drive.context,
	);
}

export async function readBoundedContext<TContext extends object | undefined, TState extends OperationState>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: TState,
): Promise<ContinueOperationResult<AgentMessage[]>> {
	const entries = await readBoundedEntries(lane, drive, capability);
	if (entries.kind === "cancel_requested") return entries;
	return {
		kind: "result",
		value: await buildSessionContext(
			entries.value,
			{ entryProjectors: lane.readConfig().entryProjectors },
			drive.context,
		),
	};
}

export function readLaneQueues(
	reader: SessionReader,
	inbox: readonly InboxItem[],
	context: Context,
): Promise<LaneQueuedItem[]> {
	return Promise.all(
		inbox.map(async (item): Promise<LaneQueuedItem> => {
			const stored = await reader.getValue(pendingEntry(item.entryId), context);
			if (stored === undefined) {
				throw new SessionInvariantError(`Pending ${item.kind} entry ${item.entryId} is missing its payload`);
			}
			if (stored.value.type === "message") {
				return { entryId: item.entryId, kind: item.kind, type: "message", message: stored.value.payload };
			}
			if (item.kind !== "write") {
				throw new SessionInvariantError(`Pending ${item.kind} entry ${item.entryId} is not a message`);
			}
			return {
				entryId: item.entryId,
				kind: "write",
				type: "custom",
				customType: stored.value.customType,
				...(stored.value.payload === undefined ? {} : { data: stored.value.payload }),
			};
		}),
	);
}

export function readPendingMessages(
	reader: SessionReader,
	ids: readonly string[],
	description: string,
	context: Context,
): Promise<Array<{ entryId: string; message: AgentMessage }>> {
	return Promise.all(
		ids.map(async (entryId) => {
			const value = await reader.getValue(pendingEntry(entryId), context);
			if (value?.value.type !== "message") {
				throw new SessionInvariantError(`${description} ${entryId} is missing its message payload`);
			}
			return { entryId, message: value.value.payload };
		}),
	);
}
