import { copyJson, type Draft, type JsonRepresentation } from "@earendil-works/chord";
import { defineDoc } from "../documents.ts";
import { UserEntry } from "../entries.ts";
import type { ConversationId, EntryDraft, EntryId, EntryRecord, JsonObject, SubmissionId, Tx } from "../types.ts";
import type { InputEntry, QueueMode, Settings, UserInput } from "./types.ts";

/** A queued submission: user input for a run, with the entry it is placed as when not `pi.user`, or an entry write. */
export type InboxItem =
	| {
			id: SubmissionId;
			mode: "steer" | "followUp";
			content: JsonRepresentation<UserInput>;
			entry?: JsonRepresentation<InputEntry>;
	  }
	/** `entry` is an `EntryDraft`, stored as plain JSON. */
	| { id: SubmissionId; mode: "write"; entry: JsonObject };

/** Built-in queue of one conversation's submissions waiting for a boundary, in ID order. */
export type InboxState = { items: InboxItem[] };

export const InboxDoc = defineDoc<InboxState>({
	kind: "pi.inbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
	checkpointWhen: (value) => value.items.length === 0,
});

/** The settings a boundary reads, on the Session line. */
export type QueueModes = Pick<Settings, "steeringMode" | "followUpMode">;

/** What a boundary reads before the commit's first table write, and the newest head it has seen so far. */
export type Boundary = {
	readonly conversationId: ConversationId;
	readonly inbox: Draft<InboxState>;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	/** Start of the active range, the newest head marker's `head`; advanced by heads written in this commit. */
	head: EntryId | undefined;
};

/**
 * Selected user items, in ID order, the first entry the boundary placed, a write's or a user item's (a run it starts
 * begins there, `LiveRun.first`), and whether a `head: "self"` write (a reset) was placed.
 */
export type BoundaryResult = {
	readonly users: SubmissionId[];
	readonly first: EntryId | undefined;
	readonly reset: boolean;
};

/**
 * Read what a boundary needs. Table reads must precede the commit's first table write, so callers prepare the
 * boundary at the start of their commit.
 */
export async function prepareBoundary(tx: Tx, conversationId: ConversationId, modes: QueueModes): Promise<Boundary> {
	const head = (await tx.latestHeadMarker(conversationId))?.head;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return {
		conversationId,
		inbox,
		steeringMode: modes.steeringMode,
		followUpMode: modes.followUpMode,
		head,
	};
}

/**
 * Place the queued items a boundary selects (spec §6): every write, the first or all steers, and at `final` the first
 * or all follow-ups. A selected reset turns a `postTools` boundary into `final`. Writes are placed first and user
 * items after them, each in ID order, so user items queued before a reset run in the new context. A write whose head
 * targets an entry before the active range, including a range started earlier in this commit, is stale. Selected and
 * stale items are removed positionally.
 */
export async function applyBoundary(
	tx: Tx,
	boundary: Boundary,
	at: "postTools" | "final",
	now: number,
): Promise<BoundaryResult> {
	const { conversationId, inbox } = boundary;
	const items = inbox.items;
	const reset = hasQueuedReset(items);
	const final = at === "final" || reset;
	const pick = (mode: "steer" | "followUp", queueMode: QueueMode): number[] => {
		const indexes = items.flatMap((item, index) => (item.mode === mode ? [index] : []));
		return queueMode === "all" ? indexes : indexes.slice(0, 1);
	};
	const writes = items.flatMap((item, index) => (item.mode === "write" ? [index] : []));
	const users = [...pick("steer", boundary.steeringMode), ...(final ? pick("followUp", boundary.followUpMode) : [])];
	users.sort((a, b) => a - b);

	// `appendEntry()` copies the drafts' values; the items are removed only afterwards.
	let first: EntryId | undefined;
	for (const index of writes) {
		const item = items[index] as Draft<Extract<InboxItem, { mode: "write" }>>;
		const draft = item.entry as unknown as EntryDraft;
		if (isStale(boundary, draft)) {
			tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
			continue;
		}
		const entry = await tx.appendEntry(conversationId, draft);
		if (draft.head !== undefined) boundary.head = draft.head === "self" ? entry.id : draft.head;
		tx.placeSubmission(item.id, entry.id);
		first ??= entry.id;
	}
	const placed: SubmissionId[] = [];
	for (const index of users) {
		const item = items[index] as Draft<Extract<InboxItem, { mode: "steer" | "followUp" }>>;
		const entry = await appendInput(tx, conversationId, item.content as UserInput, item.entry as InputEntry, now);
		tx.placeSubmission(item.id, entry.id);
		placed.push(item.id);
		first ??= entry.id;
	}
	const removed = [...writes, ...users].sort((a, b) => b - a);
	for (const index of removed) items.splice(index, 1);
	return { users: placed, first, reset };
}

/** Append the entry an input is placed as: `entry`'s kind and data, or `pi.user`, with the user message of `content`. */
export function appendInput(
	tx: Tx,
	conversationId: ConversationId,
	content: UserInput,
	entry: InputEntry | undefined,
	now: number,
): Promise<EntryRecord> {
	const message = { role: "user", content, timestamp: now } as const;
	if (entry === undefined) return tx.appendEntry(UserEntry, conversationId, { model: [message] });
	return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: [message] });
}

/** The kind and data of an input's entry as strict JSON, without other fields an untyped caller might pass. */
export function pickInputEntry({ kind, data }: InputEntry): JsonRepresentation<InputEntry> {
	const picked = data === undefined ? { kind } : { kind, data };
	return copyJson(picked, { omitUndefinedProperties: true }) as JsonRepresentation<InputEntry>;
}

/**
 * Whether a write is display-only: it has no `model`, `head`, or `edits` (present counts, even if empty), so it changes
 * nothing the model sees and needs no boundary.
 */
export function isDisplayOnly(entry: EntryDraft): boolean {
	return entry.model === undefined && entry.head === undefined && entry.edits === undefined;
}

/** Whether a reset (`head: "self"` write) is queued; entries appended before it leave the active range when it lands. */
export function hasQueuedReset(items: readonly InboxItem[]): boolean {
	return items.some((item) => item.mode === "write" && item.entry.head === "self");
}

/** Whether a head write targets an entry before the active range, so placing it would bring back cut history. */
export function isStale(boundary: Boundary, entry: EntryDraft): boolean {
	return typeof entry.head === "number" && boundary.head !== undefined && entry.head < boundary.head;
}

/** Remove a withdrawn submission's item; the caller settles the submission. */
export async function removeInboxItem(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
	const items = (await tx.doc(InboxDoc, conversationId)).items;
	const index = items.findIndex((item) => item.id === id);
	if (index >= 0) items.splice(index, 1);
}

/**
 * Withdraw every queued input of a conversation, as `Conversation.abort()` and abort cascades do: each settles
 * `unanswered` with `reason` (default `aborted`) and leaves the inbox; queued writes stay for later placement.
 */
export async function withdrawQueuedInputs(tx: Tx, conversationId: ConversationId, reason = "aborted"): Promise<void> {
	const items = (await tx.doc(InboxDoc, conversationId)).items;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]!;
		if (item.mode === "write") continue;
		tx.settleSubmission(item.id, { status: "unanswered", reason });
		items.splice(index, 1);
	}
}
