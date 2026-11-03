// A session's copy for the sync tests: a Chord store over a SQLite database with its outbox on, and Durable's storage
// in it under one owner name. The store is what syncs; the storage is opened on it only while something commits.

import { type Backend, openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { StoreStorage } from "../src/storage/store/index.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import type { Storage, StorageWrite } from "../src/types.ts";

const context = BACKGROUND_CONTEXT;

/** The owner name Durable's storage takes in a session store. */
export const SESSION_OWNER = "pi.session";

/** A backend over the SQLite file at `path`, `:memory:` by default. */
export async function backend(path = ":memory:"): Promise<Backend> {
	return sqliteBackend(await openNodeSqliteDatabase(path));
}

/** A session store with its outbox on. */
export async function sessionStore(path = ":memory:"): Promise<Store> {
	return openStore(await backend(path), context, { outbox: true });
}

/** Runs `fn` on Durable's storage in `store`, released afterwards so the store can be pulled into again. */
export async function withStorage<T>(store: Store, fn: (storage: Storage) => Promise<T>, ctx: Context = context) {
	const storage = await StoreStorage.open(store, SESSION_OWNER, ctx);
	try {
		return await fn(storage);
	} finally {
		await storage.close(ctx);
	}
}

/** Commits each batch through Durable's storage in `store`. */
export async function commitAll(store: Store, batches: readonly (readonly StorageWrite[])[]): Promise<void> {
	await withStorage(store, async (storage) => {
		for (const batch of batches) await commitWrites(storage, batch, context);
	});
}

/**
 * What a Session reads of the store, as one comparable value: its records and every live document. Two copies that
 * read the same hold the same session.
 */
export async function reads(store: Store): Promise<Record<string, unknown>> {
	return withStorage(store, async (storage) => {
		const out: Record<string, unknown> = { head: store.lastSeq };
		const conversations = (await storage.scanConversations({}, 1000, undefined, context)).items;
		out.conversations = conversations;
		for (const conversation of conversations) {
			const entries = (
				await storage.scanEntries({ conversationId: conversation.id, order: "ascending" }, 1000, undefined, context)
			).items;
			out[`entries:${conversation.id}`] = entries;
		}
		const tasks = (await storage.scanTasks({}, 1000, undefined, context)).items;
		out.tasks = tasks;
		out.submissions = (await storage.scanSubmissions({}, 1000, undefined, context)).items;
		const scopes = [
			{ kind: "session" as const },
			...conversations.map((conversation) => ({ kind: "conversation" as const, conversationId: conversation.id })),
			...tasks.map((item) => ({ kind: "task" as const, taskId: item.id })),
		];
		for (const scope of scopes) {
			const documents = (await storage.scanDocuments({ scope, at: "current" }, 1000, undefined, context)).items;
			out[`documents:${JSON.stringify(scope)}`] = await Promise.all(
				documents.map(async (record) => ({ record, value: await storage.document(record.id, "current", context) })),
			);
		}
		return out;
	});
}
