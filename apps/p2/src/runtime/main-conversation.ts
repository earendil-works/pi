// The session's top-level conversations (the main conversation and its `/tree` branches) and which one is current.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type ConversationRecord,
	type DocumentReader,
	defineDoc,
	ROOT_CONVERSATION_ID,
	type Session,
} from "@earendil-works/pi-durable";

/**
 * The session's top-level conversations (`docs/tree.md`): conversation 1 and the branches `/tree` created, in creation
 * order, and the current main conversation among them, the one the session shows and follows. Session-scoped, so a
 * fork never copies it. An explicit list, not "conversations no task owns": older sessions have subagents created
 * without an owner.
 */
export const MainDoc = defineDoc<{ conversation: number; branches: number[] }>({
	kind: "p2.main",
	version: 1,
	scope: "session",
	initial: () => ({ conversation: ROOT_CONVERSATION_ID, branches: [ROOT_CONVERSATION_ID] }),
	checkpointWhen: () => true,
});

/** The current main conversation's ID. */
export async function mainConversation(read: DocumentReader, context: Context): Promise<ConversationId> {
	return ((await read.snapshot(MainDoc, context))?.conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
}

/** The top-level conversations' IDs: conversation 1, then the `/tree` branches. */
export async function topLevelConversations(read: DocumentReader, context: Context): Promise<ConversationId[]> {
	return ((await read.snapshot(MainDoc, context))?.branches ?? [ROOT_CONVERSATION_ID]) as ConversationId[];
}

/** Whether conversation `id` is top-level (conversation 1 or a `/tree` branch), not a subagent or one-shot agent. */
export async function isTopLevel(read: DocumentReader, id: ConversationId, context: Context): Promise<boolean> {
	return (await topLevelConversations(read, context)).includes(id);
}

/**
 * The conversation holding an agent's own documents (its artifacts list, voice and chat mode): conversation 1 for the
 * main agent, whichever top-level conversation it works in, so a `/tree` switch keeps them; a subagent's or one-shot
 * agent's own conversation otherwise. TODO: these could become session-scoped documents keyed per agent (a migration).
 */
export async function agentConversation(
	read: DocumentReader,
	id: ConversationId,
	context: Context,
): Promise<ConversationId> {
	return (await isTopLevel(read, id, context)) ? ROOT_CONVERSATION_ID : id;
}

/** The top-level conversations' records (their fork points), in ID order; records are table reads, in a commit. */
export async function topLevelRecords(session: Session, context: Context): Promise<ConversationRecord[]> {
	const ids = await topLevelConversations(session, context);
	return session.commit(async (tx) => {
		const records: ConversationRecord[] = [];
		for (const id of ids) {
			const record = await tx.conversation(id);
			if (record) records.push(record);
		}
		return records.sort((a, b) => a.id - b.id);
	}, context);
}
