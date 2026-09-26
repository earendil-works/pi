import type { Context } from "@earendil-works/chord";
import { addressId } from "../documents.ts";
import type {
	ConversationId,
	Cursor,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentRecord,
	EntryId,
	Storage,
} from "../types.ts";

const SCAN_PAGE_SIZE = 256;

type ForkPolicy = "asOf" | "current";

/** One definition-free document copy to create with a forked conversation. */
export type ForkDocumentCopy = {
	readonly record: DocumentCreate;
	readonly source: DocumentCopySource;
};

/** Select every persisted conversation document copied by one fork. */
export async function prepareForkDocumentCopies(
	storage: Storage,
	parentConversationId: ConversationId,
	at: EntryId,
	childConversationId: ConversationId,
	context: Context,
): Promise<readonly ForkDocumentCopy[]> {
	const entry = await storage.entry(parentConversationId, at, context);
	if (entry === undefined) throw new Error(`Entry ${at} is not visible from conversation ${parentConversationId}`);

	const copies: ForkDocumentCopy[] = [];
	const copiedAddresses = new Set<string>();
	await collectCopies(
		storage,
		{ kind: "conversation", conversationId: entry.entry.conversationId },
		entry.commitSeq,
		"asOf",
		childConversationId,
		copies,
		copiedAddresses,
		context,
	);
	await collectCopies(
		storage,
		{ kind: "conversation", conversationId: parentConversationId },
		"current",
		"current",
		childConversationId,
		copies,
		copiedAddresses,
		context,
	);
	return copies;
}

async function collectCopies(
	storage: Storage,
	scope: Extract<DocumentRecord["scope"], { readonly kind: "conversation" }>,
	at: DocumentPoint,
	policy: ForkPolicy,
	childConversationId: ConversationId,
	copies: ForkDocumentCopy[],
	copiedAddresses: Set<string>,
	context: Context,
): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanDocuments({ scope, at }, SCAN_PAGE_SIZE, cursor, context);
		for (const source of page.items) {
			if (source.scope.kind !== "conversation" || source.fork !== policy) continue;
			const id = await storage.mintId<DocumentId>();
			const identity = {
				id,
				kind: source.kind,
				...(source.key === undefined ? {} : { key: source.key }),
				scope: { kind: "conversation" as const, conversationId: childConversationId },
			};
			const record: DocumentCreate =
				source.history === "latest"
					? { ...identity, history: "latest", fork: source.fork }
					: { ...identity, history: "rewindable", fork: source.fork };
			const copyAddress = addressId(record);
			if (copiedAddresses.has(copyAddress)) {
				const member = record.key === undefined ? record.kind : `${record.kind}/${record.key}`;
				throw new Error(`Fork selects multiple source documents for ${member}`);
			}
			copiedAddresses.add(copyAddress);
			copies.push({ record, source: { id: source.id, at } });
		}
		cursor = page.next;
	} while (cursor !== undefined);
}
