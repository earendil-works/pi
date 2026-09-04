import type { Context, Entry, ForkOptions, SessionCreateOptions, StoredValue } from "@earendil-works/pi-agent-core";
import { branchTip, createForkSnapshot, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	appendEntryToBranchIndex,
	applyInitialSchema,
	decodeEntryRow,
	deleteSessionRows,
	type EntryRow,
	EntryRowWriter,
	hasSessionRow,
	insertSessionRow,
	metadataFromSessionRow,
	readAllScalarValueRows,
	readAllSessionRows,
	readSessionRow,
	SQLITE_STORAGE_VERSION,
	type SqliteDatabase,
	SqliteOpenSession,
	type SqliteSessionMetadata,
	SqliteStorage,
	type SqliteStorageSnapshot,
	scanBranchEntries,
	setScalarValueRow,
	sql,
} from "@earendil-works/pi-session-backend-sqlite-node/sqlite";
import { wrapDurableSqlite } from "./database.ts";
import type { DurableSqliteStorage } from "./types.ts";

export const DURABLE_SQLITE_CONTAINER_PATH = "durable-object";

const FIRST_AVAILABLE_COMMIT_SEQ = 1;

export type DurableSqliteSessionCreateOptions = SessionCreateOptions;

export interface DurableSqliteSessionRepoOptions {
	storage: DurableSqliteStorage;
	/** Reported as `SqliteSessionMetadata.path`. One isolate, one container. */
	containerPath?: string;
	now?: () => number;
}

interface ForkSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	messageCount: number;
	nextSeq: number;
}

function storageIdentity(path: string, sessionId: string): string {
	return JSON.stringify([path, sessionId]);
}

function readSourceEntries(db: SqliteDatabase, sessionId: string): Entry[] {
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`
		.all<EntryRow>(db)
		.map(decodeEntryRow);
}

function buildForkSnapshot(source: SqliteStorageSnapshot, options: ForkOptions): ForkSnapshot {
	const snapshot = createForkSnapshot(
		{
			entries: source.entries,
			scalarValues: source.scalarValues,
			entriesComplete: source.entriesComplete,
		},
		options,
	);
	const entries = [...snapshot.entries.values()].sort((left, right) => left.seq - right.seq);
	return {
		entries,
		scalarValues: snapshot.scalarValues,
		messageCount: entries.filter((entry) => entry.type === "message").length,
		nextSeq: snapshot.nextSeq,
	};
}

function readForkSourceEntries(
	db: SqliteDatabase,
	sessionId: string,
	scalarValues: readonly StoredValue<unknown>[],
	options: ForkOptions,
): Entry[] {
	if (options.scope === "tree") return readSourceEntries(db, sessionId);
	const sourceAddress = branchTip(options.branch);
	const sourceTip = scalarValues.find(
		(stored) => stored.address.namespace === sourceAddress.namespace && stored.address.key === sourceAddress.key,
	) as StoredValue<string | null> | undefined;
	if (sourceTip === undefined) throw new Error(`Unknown source branch: ${options.branch}`);
	return sourceTip.value === null
		? []
		: scanBranchEntries(db, sessionId, { start: sourceTip.value, order: "oldestFirst" });
}

function createSqliteForkSnapshot(
	db: SqliteDatabase,
	source: SqliteSessionMetadata,
	options: ForkOptions,
): ForkSnapshot {
	return db.transaction(() => {
		metadataFromSessionRow(source.path, readSessionRow(db, source.id), SQLITE_STORAGE_VERSION);
		const scalarValues = readAllScalarValueRows(db, source.id);
		return buildForkSnapshot(
			{
				entries: readForkSourceEntries(db, source.id, scalarValues, options),
				scalarValues,
				entriesComplete: options.scope === "tree",
			},
			options,
		);
	});
}

function insertForkValue(db: SqliteDatabase, sessionId: string, stored: StoredValue<unknown>): void {
	setScalarValueRow(db, sessionId, stored.address.namespace, stored.address.key, stored.seq, stored.value);
}

function updateForkSessionStats(db: SqliteDatabase, sessionId: string, messageCount: number): void {
	sql`UPDATE sessions SET message_count = ${messageCount} WHERE id = ${sessionId}`.run(db);
}

/**
 * Session repository for one Durable Object SQLite database.
 * Sessions are rows (`session_id`), not files. The isolate is the writer lock.
 */
export class DurableSqliteSessionRepo {
	private readonly db: SqliteDatabase;
	private readonly containerPath: string;
	private readonly now: () => number;
	private readonly pendingIds = new Set<string>();
	private readonly openStorages = new Map<string, SqliteStorage>();
	private readonly openSessions = new Set<SqliteOpenSession>();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private schemaApplied = false;

	constructor(options: DurableSqliteSessionRepoOptions) {
		this.db = wrapDurableSqlite(options.storage);
		this.containerPath = options.containerPath ?? DURABLE_SQLITE_CONTAINER_PATH;
		this.now = options.now ?? Date.now;
	}

	async create(options: DurableSqliteSessionCreateOptions | undefined, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		options ??= {};
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		let session: SqliteOpenSession | undefined;
		try {
			await this.ensureSchema();
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				storageVersion: SQLITE_STORAGE_VERSION,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
				path: this.containerPath,
			};
			this.db.transaction(() => {
				if (hasSessionRow(this.db, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(this.db, metadata, SQLITE_STORAGE_VERSION, FIRST_AVAILABLE_COMMIT_SEQ);
			});
			session = this.openStorageBackedSession(metadata);
			return session;
		} finally {
			if (session === undefined) this.pendingIds.delete(id);
		}
	}

	async open(metadata: SqliteSessionMetadata, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		this.reserveId(metadata.id);
		let session: SqliteOpenSession | undefined;
		try {
			await this.ensureSchema();
			this.assertContainerPath(metadata.path);
			const stored = metadataFromSessionRow(
				this.containerPath,
				readSessionRow(this.db, metadata.id),
				SQLITE_STORAGE_VERSION,
			);
			session = this.openStorageBackedSession(stored);
			return session;
		} finally {
			if (session === undefined) this.pendingIds.delete(metadata.id);
		}
	}

	async list(_options: undefined, _context: Context): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		await this.ensureSchema();
		return readAllSessionRows(this.db)
			.map((row) => metadataFromSessionRow(this.containerPath, row, SQLITE_STORAGE_VERSION))
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	async delete(metadata: SqliteSessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		this.reserveId(metadata.id);
		try {
			await this.ensureSchema();
			this.assertContainerPath(metadata.path);
			this.db.transaction(() => {
				metadataFromSessionRow(this.containerPath, readSessionRow(this.db, metadata.id), SQLITE_STORAGE_VERSION);
				deleteSessionRows(this.db, metadata.id);
			});
		} finally {
			this.pendingIds.delete(metadata.id);
		}
	}

	async fork(source: SqliteSessionMetadata, options: ForkOptions, context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		this.assertContainerPath(source.path);
		const sourceStorage = this.openStorages.get(storageIdentity(this.containerPath, source.id));
		const activeSourceSnapshot = sourceStorage?.snapshot(options, context);
		void activeSourceSnapshot?.catch(() => undefined);
		let session: SqliteOpenSession | undefined;
		try {
			await this.ensureSchema();
			const snapshot =
				activeSourceSnapshot === undefined
					? createSqliteForkSnapshot(this.db, { ...source, path: this.containerPath }, options)
					: buildForkSnapshot(await activeSourceSnapshot, options);

			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				storageVersion: SQLITE_STORAGE_VERSION,
				parentSessionId: source.id,
				path: this.containerPath,
			};
			this.db.transaction(() => {
				if (hasSessionRow(this.db, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(this.db, metadata, SQLITE_STORAGE_VERSION, snapshot.nextSeq);
				const entryWriter = new EntryRowWriter(this.db, id);
				for (const entry of snapshot.entries) {
					entryWriter.insert(entry);
					appendEntryToBranchIndex(this.db, id, entry);
				}
				for (const stored of snapshot.scalarValues) insertForkValue(this.db, id, stored);
				updateForkSessionStats(this.db, id, snapshot.messageCount);
			});
			session = this.openStorageBackedSession(metadata);
			return session;
		} finally {
			if (session === undefined) this.pendingIds.delete(id);
		}
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.closePromise = this.closeOpenSessions(context);
		return this.closePromise;
	}

	private async ensureSchema(): Promise<void> {
		if (this.schemaApplied) return;
		await applyInitialSchema(this.db);
		this.schemaApplied = true;
	}

	private async closeOpenSessions(context: Context): Promise<void> {
		const results = await Promise.allSettled([...this.openSessions].map((session) => session.close(context)));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close SQLite Sessions");
	}

	private openStorageBackedSession(metadata: SqliteSessionMetadata): SqliteOpenSession {
		const key = storageIdentity(this.containerPath, metadata.id);
		const storage = new SqliteStorage(this.db, { sessionId: metadata.id, now: this.now });
		this.openStorages.set(key, storage);
		const session = new StorageBackedSession(metadata, storage);
		const openSession = new SqliteOpenSession(session, {
			onClose: () => {
				if (this.openStorages.get(key) === storage) this.openStorages.delete(key);
				this.openSessions.delete(openSession);
				this.pendingIds.delete(metadata.id);
			},
		});
		this.openSessions.add(openSession);
		return openSession;
	}

	private assertContainerPath(path: string): void {
		if (path !== this.containerPath) {
			throw new Error(`SQLite session metadata path is outside this repository: ${path}`);
		}
	}

	private reserveId(id: string): void {
		if (this.pendingIds.has(id)) throw new Error(`Session is already open: ${id}`);
		this.pendingIds.add(id);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("DurableSqliteSessionRepo is closed");
	}
}
