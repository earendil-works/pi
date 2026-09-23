import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteStorage } from "../src/storage/sqlite/index.ts";
import { type NodeSqliteStorageOptions, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { DocumentCreate, EntryRecord, Seq, Storage, StorageWrite, TaskRecord } from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

const context = BACKGROUND_CONTEXT;
const openStorages = new Set<SqliteStorage>();
const tempDirectories = new Set<string>();

afterEach(async () => {
	for (const storage of openStorages) await storage.close(context);
	openStorages.clear();
	for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
	tempDirectories.clear();
});

async function createSqliteStorage(options: { readonly walAutoCheckpointPages?: number } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-sqlite-"));
	tempDirectories.add(directory);
	const path = join(directory, "storage.sqlite");
	const storage = await openNodeSqliteStorage(path, options);
	openStorages.add(storage);
	return { storage, path };
}

class ReopeningStorage implements Storage {
	private current: SqliteStorage;
	private readonly path: string;
	private readonly options: NodeSqliteStorageOptions;
	private closed = false;

	constructor(current: SqliteStorage, path: string, options: NodeSqliteStorageOptions = {}) {
		this.current = current;
		this.path = path;
		this.options = options;
	}

	async commit(writes: readonly StorageWrite[], commitContext: Parameters<Storage["commit"]>[1]): Promise<Seq> {
		if (this.closed) return this.current.commit(writes, commitContext);
		try {
			return await this.current.commit(writes, commitContext);
		} finally {
			await this.current.close(context);
			this.current = await openNodeSqliteStorage(this.path, this.options);
		}
	}

	mintId: Storage["mintId"] = () => this.current.mintId();
	conversation: Storage["conversation"] = (id, readContext) => this.current.conversation(id, readContext);
	scanConversations: Storage["scanConversations"] = (cursor, limit, readContext) =>
		this.current.scanConversations(cursor, limit, readContext);
	entry: Storage["entry"] = (id, readContext) => this.current.entry(id, readContext);
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (conversationId, at, readContext) =>
		this.current.findLatestHeadMarker(conversationId, at, readContext);
	scanEntries: Storage["scanEntries"] = (query, cursor, limit, readContext) =>
		this.current.scanEntries(query, cursor, limit, readContext);
	task: Storage["task"] = (id, readContext) => this.current.task(id, readContext);
	scanTasks: Storage["scanTasks"] = (query, cursor, limit, readContext) =>
		this.current.scanTasks(query, cursor, limit, readContext);
	submission: Storage["submission"] = (id, readContext) => this.current.submission(id, readContext);
	submissionByRequest: Storage["submissionByRequest"] = (conversationId, requestId, readContext) =>
		this.current.submissionByRequest(conversationId, requestId, readContext);
	findDocument: Storage["findDocument"] = (address, at, readContext) =>
		this.current.findDocument(address, at, readContext);
	document: Storage["document"] = (id, at, readContext) => this.current.document(id, at, readContext);
	scanDocuments: Storage["scanDocuments"] = (query, cursor, limit, readContext) =>
		this.current.scanDocuments(query, cursor, limit, readContext);

	async close(closeContext: Parameters<Storage["close"]>[0]): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.current.close(closeContext);
	}
}

registerStorageConformance({ describe, expect, it }, "SqliteStorage", async (use) =>
	use((await createSqliteStorage()).storage),
);

registerStorageConformance({ describe, expect, it }, "SqliteStorage across reopen", async (use) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-sqlite-conformance-"));
	const path = join(directory, "storage.sqlite");
	const created = await openNodeSqliteStorage(path);
	await created.close(context);
	const storage = new ReopeningStorage(await openNodeSqliteStorage(path), path);
	try {
		await use(storage);
	} finally {
		await storage.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

function entry(id: number, conversationId: number, data?: JsonValue): EntryRecord {
	return { id, conversationId, kind: "message", ...(data === undefined ? {} : { data }) };
}

async function createRoot(storage: Storage): Promise<number> {
	return storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
}

function pendingTask(id: number): TaskRecord<JsonValue, JsonValue, JsonValue> {
	return {
		id,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "test.task",
		version: 1,
		input: null,
		state: { status: "pending", checkpoint: { phase: "ready" } },
		after: [],
		background: false,
		abortRequested: false,
	};
}

function scalar(db: DatabaseSync, sql: string): number {
	const row = db.prepare(sql).get() as { readonly value: number };
	return row.value;
}

function revisionCount(path: string, documentId: number): number {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const row = db
			.prepare("SELECT count(*) AS count FROM document_revisions WHERE document_id = ?")
			.get(documentId) as { readonly count: number };
		return row.count;
	} finally {
		db.close();
	}
}

describe("Pico SqliteStorage", () => {
	it("persists records, sequence allocation, and global ID allocation across reopen", async () => {
		const { storage, path } = await createSqliteStorage();
		expect(await createRoot(storage)).toBe(1);
		const entryId = await storage.mintId();
		expect(await storage.commit([{ type: "entry", value: entry(entryId, ROOT_CONVERSATION_ID) }], context)).toBe(2);
		await storage.close(context);
		openStorages.delete(storage);

		const reopened = await openNodeSqliteStorage(path);
		openStorages.add(reopened);
		expect(await reopened.entry(entryId, context)).toEqual({
			entry: entry(entryId, ROOT_CONVERSATION_ID),
			commitSeq: 2,
		});
		expect(await reopened.mintId()).toBe(entryId + 1);
		expect(await reopened.commit([{ type: "task", value: pendingTask(await reopened.mintId()) }], context)).toBe(3);
	});

	it("rejects persisted metadata corruption on reopen", async () => {
		const { storage, path } = await createSqliteStorage();
		await storage.close(context);
		openStorages.delete(storage);
		const database = new DatabaseSync(path);
		try {
			database.exec("DELETE FROM durable_metadata");
		} finally {
			database.close();
		}
		await expect(openNodeSqliteStorage(path)).rejects.toThrow("Durable SQLite metadata is missing");
	});

	it("rejects a document whose required base is missing", async () => {
		const { storage, path } = await createSqliteStorage();
		await createRoot(storage);
		const id = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: { id, kind: "corrupt", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { retained: true } },
				},
			],
			context,
		);
		const database = new DatabaseSync(path);
		try {
			database.prepare("DELETE FROM document_revisions WHERE document_id = ?").run(id);
		} finally {
			database.close();
		}
		await expect(storage.document(id, "current", context)).rejects.toThrow(
			`Document ${id} is missing a required base`,
		);
	});

	it("rolls SQL rows and sequence allocation back as one transaction", async () => {
		const { storage, path } = await createSqliteStorage();
		await createRoot(storage);
		const transientId = await storage.mintId();
		const transientTaskId = await storage.mintId();
		const circular: { self?: unknown } = {};
		circular.self = circular;
		await expect(
			storage.commit(
				[
					{ type: "entry", value: entry(transientId, ROOT_CONVERSATION_ID) },
					{
						type: "task",
						value: { ...pendingTask(transientTaskId), input: circular as unknown as JsonValue },
					},
				],
				context,
			),
		).rejects.toThrow("circular structure");
		expect(await storage.entry(transientId, context)).toBeUndefined();
		expect(await storage.task(transientTaskId, context)).toBeUndefined();
		const committedId = await storage.mintId();
		expect(await storage.commit([{ type: "entry", value: entry(committedId, ROOT_CONVERSATION_ID) }], context)).toBe(
			2,
		);

		const db = new DatabaseSync(path, { readOnly: true });
		try {
			expect(scalar(db, "SELECT count(*) AS value FROM entries")).toBe(1);
			expect(scalar(db, "SELECT next_seq AS value FROM durable_metadata WHERE singleton = 1")).toBe(3);
		} finally {
			db.close();
		}
	});

	it("reconstructs recent and ancient rewindable points after reopen", async () => {
		const { storage, path } = await createSqliteStorage();
		await createRoot(storage);
		const id = await storage.mintId();
		const record = {
			id,
			kind: "history",
			scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
			history: "rewindable",
			fork: "asOf",
		} satisfies DocumentCreate;
		const createdAt = await storage.commit(
			[{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 0 } } }],
			context,
		);
		let ancientAt = createdAt;
		let recentAt = createdAt;
		for (let count = 1; count <= 40; count++) {
			recentAt = await storage.commit(
				[
					{
						type: "document.change",
						id,
						content:
							count === 20
								? { kind: "base", version: 1, value: { count } }
								: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
					},
				],
				context,
			);
			if (count === 5) ancientAt = recentAt;
		}
		await storage.close(context);
		openStorages.delete(storage);
		const reopened = await openNodeSqliteStorage(path);
		openStorages.add(reopened);
		expect((await reopened.document(id, ancientAt, context))?.value).toEqual({ count: 5 });
		expect((await reopened.document(id, recentAt, context))?.value).toEqual({ count: 40 });
	});

	it("uses indexes for exact addresses, exact scopes, entry history, and document revision tails", async () => {
		const { storage, path } = await createSqliteStorage();
		await storage.close(context);
		openStorages.delete(storage);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const plans = [
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT record FROM documents
						WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
						AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`)
					.all("kind", "session", 0, 0, ""),
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT record FROM documents
						WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
						AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
						ORDER BY created_at DESC LIMIT 1`)
					.all("kind", "conversation", 1, 0, "", 10, 10),
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT record FROM documents
						WHERE scope_kind = ? AND owner_id = ? AND kind = ? AND id > ? ORDER BY id LIMIT ?`)
					.all("task", 1, "kind", 0, 10),
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT record FROM entries
						WHERE conversation_id = ? AND id <= ? ORDER BY id DESC LIMIT ?`)
					.all(1, 10, 10),
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT record FROM entries
						WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`)
					.all(1, 10),
				db
					.prepare("EXPLAIN QUERY PLAN SELECT record FROM tasks WHERE status = ? AND id > ? ORDER BY id LIMIT ?")
					.all("pending", 0, 10),
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT seq, kind, version, content FROM document_revisions
						WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`)
					.all(1, 10),
				db
					.prepare(`EXPLAIN QUERY PLAN SELECT seq, kind, version, content FROM document_revisions
						WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`)
					.all(1, 5, 10),
			];
			const details = plans.map((plan) => plan.map((row) => (row as { readonly detail: string }).detail).join("\n"));
			expect(details[0]).toContain("documents_by_address");
			expect(details[1]).toContain("documents_by_address");
			expect(details[2]).toContain("documents_by_scope_kind");
			expect(details[3]).toContain("entries_by_conversation");
			expect(details[4]).toContain("entry_heads_by_conversation");
			expect(details[5]).toContain("tasks_by_status");
			expect(details[6]).toContain("document_revisions_by_kind");
			expect(details[7]).toContain("sqlite_autoindex_document_revisions_1");
			for (const detail of details.slice(0, 3)) expect(detail).not.toContain("SCAN documents");
			expect(details[7]).not.toContain("SCAN document_revisions");
		} finally {
			db.close();
		}
	});

	it("reclaims current-only revisions only after a base or retirement", async () => {
		const { storage, path } = await createSqliteStorage();
		await createRoot(storage);
		const id = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: { id, kind: "latest", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { count: 0 } },
				},
			],
			context,
		);
		for (let count = 1; count <= 10; count++) {
			await storage.commit(
				[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] } }],
				context,
			);
		}
		expect(revisionCount(path, id)).toBe(11);
		const revisions = new DatabaseSync(path, { readOnly: true });
		try {
			const row = revisions
				.prepare(
					"SELECT content FROM document_revisions WHERE document_id = ? AND kind = 'delta' ORDER BY seq DESC LIMIT 1",
				)
				.get(id) as { readonly content: string };
			expect(JSON.parse(row.content)).toEqual([["s", ["count"], 10]]);
		} finally {
			revisions.close();
		}
		await storage.commit(
			[{ type: "document.change", id, content: { kind: "base", version: 1, value: { count: 11 } } }],
			context,
		);
		expect(revisionCount(path, id)).toBe(1);
		await storage.commit(
			[
				{
					type: "document.change",
					id,
					content: { kind: "delta", version: 1, ops: [["r", { count: 12 }]] },
				},
			],
			context,
		);
		expect(revisionCount(path, id)).toBe(2);
		await storage.commit([{ type: "document.retire", id }], context);
		expect(revisionCount(path, id)).toBe(0);
	});

	it("auto-checkpoints WAL frames and truncates the WAL on close", async () => {
		const { storage, path } = await createSqliteStorage({ walAutoCheckpointPages: 1 });
		await createRoot(storage);
		for (let index = 0; index < 20; index++) {
			await storage.commit(
				[
					{
						type: "entry",
						value: entry(await storage.mintId(), ROOT_CONVERSATION_ID, { text: "x".repeat(32 * 1024), index }),
					},
				],
				context,
			);
		}
		const walPath = `${path}-wal`;
		expect((await stat(walPath)).size).toBeLessThan(512 * 1024);
		const observer = new DatabaseSync(path, { readOnly: true });
		try {
			expect(scalar(observer, "SELECT count(*) AS value FROM entries")).toBe(20);
			await storage.close(context);
			openStorages.delete(storage);
			expect((await stat(walPath)).size).toBe(0);
		} finally {
			observer.close();
		}
	});

	it("reuses pages released by current-only checkpoints", async () => {
		const { storage, path } = await createSqliteStorage();
		await createRoot(storage);
		const id = await storage.mintId();
		const large = "x".repeat(512 * 1024);
		await storage.commit(
			[
				{
					type: "document.create",
					record: { id, kind: "reuse", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { text: large } },
				},
			],
			context,
		);
		await storage.commit(
			[{ type: "document.change", id, content: { kind: "base", version: 1, value: { text: "small" } } }],
			context,
		);
		const before = new DatabaseSync(path, { readOnly: true });
		let pagesAfterDelete: number;
		let freeAfterDelete: number;
		try {
			pagesAfterDelete = scalar(before, "SELECT page_count AS value FROM pragma_page_count() ");
			freeAfterDelete = scalar(before, "SELECT freelist_count AS value FROM pragma_freelist_count() ");
		} finally {
			before.close();
		}
		expect(freeAfterDelete).toBeGreaterThan(0);
		await storage.commit(
			[{ type: "document.change", id, content: { kind: "base", version: 1, value: { text: large } } }],
			context,
		);
		const after = new DatabaseSync(path, { readOnly: true });
		try {
			const pagesAfterReuse = scalar(after, "SELECT page_count AS value FROM pragma_page_count() ");
			const freeAfterReuse = scalar(after, "SELECT freelist_count AS value FROM pragma_freelist_count() ");
			expect(pagesAfterReuse).toBeLessThanOrEqual(pagesAfterDelete + 2);
			expect(freeAfterReuse).toBeLessThan(freeAfterDelete);
		} finally {
			after.close();
		}
	});

	it("keeps representative row and document storage bounded", async () => {
		const { storage, path } = await createSqliteStorage();
		await createRoot(storage);
		for (let index = 0; index < 100; index++) {
			await storage.commit(
				[
					{
						type: "entry",
						value: entry(await storage.mintId(), ROOT_CONVERSATION_ID, { index, text: "x".repeat(1_024) }),
					},
				],
				context,
			);
		}
		const documentId = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: {
						id: documentId,
						kind: "size.history",
						scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
						history: "rewindable",
						fork: "asOf",
					},
					content: { kind: "base", version: 1, value: { count: 0 } },
				},
			],
			context,
		);
		for (let count = 1; count <= 100; count++) {
			await storage.commit(
				[
					{
						type: "document.change",
						id: documentId,
						content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
					},
				],
				context,
			);
		}
		await storage.close(context);
		openStorages.delete(storage);
		expect((await stat(path)).size).toBeLessThan(1024 * 1024);
	});
});
