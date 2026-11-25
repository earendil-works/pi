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
 * A top-level conversation and its label, what the sidebar and `/tree` call it. Null shows the session title:
 * conversation 1's default (it has no fork point), so it follows a session rename until the branch is renamed.
 */
export type MainBranch = { conversation: number; label: string | null };

/** `p2.main`: the current main conversation and the top-level conversations in creation order. */
export type MainState = { conversation: number; branches: MainBranch[] };

/**
 * The session's top-level conversations (`docs/tree.md`): conversation 1 and the branches `/tree` created, in creation
 * order, each with its label, and the current main conversation among them, the one the session shows and follows.
 * Session-scoped, so a fork never copies it. An explicit list, not "conversations no task owns": older sessions have
 * subagents created without an owner.
 */
export const MainDoc = defineDoc<MainState>({
	kind: "p2.main",
	// 2: stored labels. Version 1 listed IDs only: their labels start null, and the tree worker fills them at start.
	version: 2,
	scope: "session",
	initial: () => ({
		conversation: ROOT_CONVERSATION_ID,
		branches: [{ conversation: ROOT_CONVERSATION_ID, label: null }],
	}),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`Unknown p2.main version ${fromVersion}`);
		const state = value as unknown as { conversation: number; branches: number[] };
		return {
			conversation: state.conversation,
			branches: state.branches.map((conversation) => ({ conversation, label: null })),
		};
	},
	checkpointWhen: () => true,
});

/** The current main conversation's ID. */
export async function mainConversation(read: DocumentReader, context: Context): Promise<ConversationId> {
	return ((await read.snapshot(MainDoc, context))?.conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
}

/** The top-level conversations' IDs: conversation 1, then the `/tree` branches. */
export async function topLevelConversations(read: DocumentReader, context: Context): Promise<ConversationId[]> {
	const branches = (await read.snapshot(MainDoc, context))?.branches;
	return (branches?.map((branch) => branch.conversation) ?? [ROOT_CONVERSATION_ID]) as ConversationId[];
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
