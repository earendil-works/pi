// Conversation deletion's state and policy (spec §2.2): the built-in `pi.deletions` document of the conversations being
// deleted, and the set a deletion takes, with its refusals.
import { addressId, defineDoc } from "../documents.ts";
import { DeletionRefused } from "../errors.ts";
import { documentKey } from "../session/keys.ts";
import {
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	ROOT_CONVERSATION_ID,
	type Tx,
} from "../types.ts";
import { scanAll } from "./util.ts";

/**
 * The conversations `Harness.deleteConversations()` closed and has not deleted yet, by ID, in a built-in session
 * document; each leaves in the commit that deletes it.
 */
export type DeletionsState = { conversations: number[] };

export const DeletionsDoc = defineDoc<DeletionsState>({
	kind: "pi.deletions",
	version: 1,
	scope: "session",
	initial: () => ({ conversations: [] }),
	checkpointWhen: () => true,
});

/** The document's key on the Session line, which a check of a conversation's closing touches. */
export const DELETIONS_KEY = documentKey(addressId({ kind: DeletionsDoc.definition.kind, scope: { kind: "session" } }));

const SCAN_PAGE_SIZE = 256;

/**
 * The conversations a deletion of `ids` takes: them and, transitively, their forks, whose history reads theirs, and
 * the conversations their tasks own; unknown IDs are skipped. Table reads, so before the commit's first table write.
 * Throws `DeletionRefused` for the root conversation and one owned by a live task outside the set.
 */
export async function deletionSet(tx: Tx, ids: readonly ConversationId[]): Promise<ConversationRecord[]> {
	const scan = (query: ConversationQuery) => scanAll((cursor) => tx.scanConversations(query, SCAN_PAGE_SIZE, cursor));
	const set = new Map<ConversationId, ConversationRecord>();
	for (const id of ids) {
		const record = await tx.conversation(id);
		if (record !== undefined) set.set(id, record);
	}
	// Also visits the entries added while it iterates: forks and owned conversations of those it took.
	for (const id of set.keys()) {
		for (const query of [{ parentConversationId: id }, { ownerConversationId: id }]) {
			for (const record of await scan(query)) if (!set.has(record.id)) set.set(record.id, record);
		}
	}
	for (const record of set.values()) {
		if (record.id === ROOT_CONVERSATION_ID) throw new DeletionRefused(record.id, { kind: "root" });
		const owner = record.owner;
		if (owner !== undefined && !set.has(owner.conversationId)) {
			const task = await tx.task(owner.taskId);
			if (task !== undefined && task.state.status !== "terminal") {
				throw new DeletionRefused(record.id, { kind: "owner", taskId: owner.taskId });
			}
		}
	}
	return [...set.values()];
}
