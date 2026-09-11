import { mkdir, open as openFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, Entry, ForkOptions, SessionCreateOptions, StoredValue } from "@earendil-works/pi-agent-core";
import { branchTip, createForkSnapshot, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { applyInitialSchema } from "./migrations.ts";
import { appendEntryToBranchIndex, scanBranchEntries } from "./session/branch-entries.ts";
import { decodeEntryRow, type EntryRow, EntryRowWriter } from "./session/entries.ts";
import {
	deleteSessionRows,
	hasSessionRow,
	insertSessionRow,
	metadataFromSessionRow,
	readAllSessionRows,
	readSessionRow,
	type SqliteSessionMetadata,
} from "./session/session-row.ts";
import { readAllScalarValueRows, setScalarValueRow } from "./session/values.ts";
import { SqliteOpenSession } from "./session.ts";
import { sql } from "./sql.ts";
import { SqliteStorage, type SqliteStorageSnapshot } from "./storage.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "./types.ts";

export const SQLITE_STORAGE_VERSION = 1;
export const SQLITE_SESSION_EXTENSION = ".sqlite";

const FIRST_AVAILABLE_COMMIT_SEQ = 1;
const SAFE_SESSION_FILE_ID = /^[A-Za-z0-9_-]+$/;

export type SqliteSessionCreateOptions = SessionCreateOptions;

export interface SqliteSessionRepoOptions {
	directory: string;
	/** Optional single container path. Defaults to one encoded `${id}.sqlite` file per session under directory. */
	databasePath?: string;
	databaseFactory: SqliteDatabaseFactory;
	now?: () => number;
}

function sessionFileName(id: string): string {
	if (SAFE_SESSION_FILE_ID.test(id)) return `${id}${SQLITE_SESSION_EXTENSION}`;
	const encoded = Buffer.from(id, "utf16le").toString("base64url");
	return `~${encoded}${SQLITE_SESSION_EXTENSION}`;
}

function sessionPath(directory: string, id: string): string {
	return join(directory, sessionFileName(id));
}

function storageIdentity(path: string, sessionId: string): string {
	return JSON.stringify([path, sessionId]);
}

function isErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function removeSessionFiles(path: string, options: { force: boolean }): Promise<void> {
	await rm(path, { force: options.force });
	await rm(`${path}-wal`, { force: true });
	await rm(`${path}-shm`, { force: true });
}

function configureWritableConnection(db: SqliteDatabase): void {
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}

function configureReadOnlyConnection(db: SqliteDatabase): void {
	db.exec("PRAGMA busy_timeout = 5000;");
}

interface ForkSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	messageCount: number;
	nextSeq: number;
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

// TODO(WP08): Remove this snapshot path when SQLite forks use streaming staging.
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
	sourceDb: SqliteDatabase,
	source: SqliteSessionMetadata,
	options: ForkOptions,
): ForkSnapshot {
	sourceDb.exec("BEGIN");
	let committed = false;
	try {
		metadataFromSessionRow(source.path, readSessionRow(sourceDb, source.id), SQLITE_STORAGE_VERSION);
		const scalarValues = readAllScalarValueRows(sourceDb, source.id);
		const snapshot = buildForkSnapshot(
			{
				entries: readForkSourceEntries(sourceDb, source.id, scalarValues, options),
				scalarValues,
				entriesComplete: options.scope === "tree",
			},
			options,
		);
		sourceDb.exec("COMMIT");
		committed = true;
		return snapshot;
	} catch (error) {
		if (!committed) sourceDb.exec("ROLLBACK");
		throw error;
	}
}

function insertForkValue(db: SqliteDatabase, sessionId: string, stored: StoredValue<unknown>): void {
	setScalarValueRow(db, sessionId, stored.address.namespace, stored.address.key, stored.seq, stored.value);
}

function updateForkSessionStats(db: SqliteDatabase, sessionId: string, messageCount: number): void {
	sql`UPDATE sessions SET message_count = ${messageCount} WHERE id = ${sessionId}`.run(db);
}

export class SqliteSessionRepo {
	private readonly directory: string;
	private readonly databasePath: string | undefined;
	private readonly databaseFactory: SqliteDatabaseFactory;
	private readonly now: () => number;
	private readonly pendingIds = new Set<string>();
	private readonly openStorages = new Map<string, SqliteStorage>();
	private readonly openSessions = new Set<SqliteOpenSession>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: SqliteSessionRepoOptions) {
		this.directory = options.directory;
		this.databasePath = options.databasePath;
		this.databaseFactory = options.databaseFactory;
		this.now = options.now ?? Date.now;
	}

	async create(options: SqliteSessionCreateOptions | undefined, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		options ??= {};
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const path = this.pathForSession(id);
		let db: SqliteDatabase | undefined;
		let reservedFile = false;
		let initialized = false;
		let session: SqliteOpenSession | undefined;
		try {
			await mkdir(dirname(path), { recursive: true });
			if (!this.usesSharedDatabase()) {
				const file = await openFile(path, "wx");
				await file.close();
				reservedFile = true;
			}
			const activeDb = await this.databaseFactory.open(path);
			db = activeDb;
			configureWritableConnection(activeDb);
			await applyInitialSchema(activeDb);
			const canonicalPath = await realpath(path);
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				storageVersion: SQLITE_STORAGE_VERSION,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
				path: canonicalPath,
			};
			activeDb.transaction(() => {
				if (hasSessionRow(activeDb, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, FIRST_AVAILABLE_COMMIT_SEQ);
			});
			initialized = true;
			session = this.openStorageBackedSession(metadata, activeDb);
			return session;
		} catch (error) {
			if (reservedFile && !initialized) await removeSessionFiles(path, { force: true });
			throw error;
		} finally {
			if (session === undefined) {
				try {
					db?.close();
				} finally {
					this.pendingIds.delete(id);
				}
			}
		}
	}

	async open(metadata: SqliteSessionMetadata, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		this.reserveId(metadata.id);
		let db: SqliteDatabase | undefined;
		let session: SqliteOpenSession | undefined;
		try {
			const path = await this.repositoryPathForMetadata(metadata);
			const activeDb = await this.databaseFactory.openExisting(path);
			db = activeDb;
			configureWritableConnection(activeDb);
			const stored = metadataFromSessionRow(path, readSessionRow(activeDb, metadata.id), SQLITE_STORAGE_VERSION);
			session = this.openStorageBackedSession(stored, activeDb);
			return session;
		} finally {
			if (session === undefined) {
				try {
					db?.close();
				} finally {
					this.pendingIds.delete(metadata.id);
				}
			}
		}
	}

	async list(_options: undefined, _context: Context): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		let paths: string[];
		if (this.usesSharedDatabase()) {
			paths = [this.databasePath!];
		} else {
			let names: string[];
			try {
				names = await readdir(this.directory);
			} catch (error) {
				if (isErrorWithCode(error, "ENOENT")) return [];
				throw error;
			}
			paths = names
				.filter((name) => name.endsWith(SQLITE_SESSION_EXTENSION))
				.map((name) => join(this.directory, name));
		}
		const sessions: SqliteSessionMetadata[] = [];
		for (const path of paths) {
			let db: SqliteDatabase | undefined;
			try {
				const canonicalPath = await realpath(path);
				db = await this.databaseFactory.openReadOnly(canonicalPath);
				configureReadOnlyConnection(db);
				for (const row of readAllSessionRows(db)) {
					sessions.push(metadataFromSessionRow(canonicalPath, row, SQLITE_STORAGE_VERSION));
				}
			} catch {
				// Discovery is best-effort: corrupt files, incompatible versions, and
				// unrelated *.sqlite files are reported when explicitly opened.
			} finally {
				db?.close();
			}
		}
		return sessions.sort((left, right) => right.createdAt - left.createdAt);
	}

	async delete(metadata: SqliteSessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		this.reserveId(metadata.id);
		try {
			const path = await this.repositoryPathForMetadata(metadata);
			const db = await this.databaseFactory.openExisting(path);
			try {
				configureWritableConnection(db);
				if (this.usesSharedDatabase()) {
					db.transaction(() => {
						metadataFromSessionRow(path, readSessionRow(db, metadata.id), SQLITE_STORAGE_VERSION);
						deleteSessionRows(db, metadata.id);
					});
				} else {
					metadataFromSessionRow(path, readSessionRow(db, metadata.id), SQLITE_STORAGE_VERSION);
				}
			} finally {
				db.close();
			}
			if (!this.usesSharedDatabase()) await removeSessionFiles(path, { force: false });
		} finally {
			this.pendingIds.delete(metadata.id);
		}
	}

	async fork(source: SqliteSessionMetadata, options: ForkOptions, context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const sourceStorage = this.openStorages.get(storageIdentity(source.path, source.id));
		const activeSourceSnapshot = sourceStorage?.snapshot(options, context);
		void activeSourceSnapshot?.catch(() => undefined);
		const path = this.pathForSession(id);
		let db: SqliteDatabase | undefined;
		let reservedFile = false;
		let initialized = false;
		let session: SqliteOpenSession | undefined;
		try {
			await mkdir(dirname(path), { recursive: true });
			if (!this.usesSharedDatabase()) {
				const file = await openFile(path, "wx");
				await file.close();
				reservedFile = true;
			}

			const snapshot =
				activeSourceSnapshot === undefined
					? await this.createForkSnapshotFromExternalSource(source, options)
					: buildForkSnapshot(await activeSourceSnapshot, options);

			const activeDb = await this.databaseFactory.open(path);
			db = activeDb;
			configureWritableConnection(activeDb);
			await applyInitialSchema(activeDb);
			const canonicalPath = await realpath(path);
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				storageVersion: SQLITE_STORAGE_VERSION,
				parentSessionId: source.id,
				path: canonicalPath,
			};
			activeDb.transaction(() => {
				if (hasSessionRow(activeDb, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, snapshot.nextSeq);
				const entryWriter = new EntryRowWriter(activeDb, id);
				for (const entry of snapshot.entries) {
					entryWriter.insert(entry);
					appendEntryToBranchIndex(activeDb, id, entry);
				}
				for (const stored of snapshot.scalarValues) insertForkValue(activeDb, id, stored);
				updateForkSessionStats(activeDb, id, snapshot.messageCount);
			});
			initialized = true;
			session = this.openStorageBackedSession(metadata, activeDb);
			return session;
		} catch (error) {
			if (reservedFile && !initialized) await removeSessionFiles(path, { force: true });
			throw error;
		} finally {
			if (session === undefined) {
				try {
					db?.close();
				} finally {
					this.pendingIds.delete(id);
				}
			}
		}
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.closePromise = this.closeOpenSessions(context);
		return this.closePromise;
	}

	private async createForkSnapshotFromExternalSource(
		source: SqliteSessionMetadata,
		options: ForkOptions,
	): Promise<ForkSnapshot> {
		const path = await realpath(source.path);
		const sourceDb = await this.databaseFactory.openReadOnly(path);
		try {
			configureReadOnlyConnection(sourceDb);
			return createSqliteForkSnapshot(sourceDb, { ...source, path }, options);
		} finally {
			sourceDb.close();
		}
	}

	private async closeOpenSessions(context: Context): Promise<void> {
		const results = await Promise.allSettled([...this.openSessions].map((session) => session.close(context)));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close SQLite Sessions");
	}

	private openStorageBackedSession(metadata: SqliteSessionMetadata, db: SqliteDatabase): SqliteOpenSession {
		const key = storageIdentity(metadata.path, metadata.id);
		const storage = new SqliteStorage(db, { sessionId: metadata.id, now: this.now });
		this.openStorages.set(key, storage);
		const session = new StorageBackedSession(metadata, storage);
		const openSession = new SqliteOpenSession(session, {
			onClose: () => {
				try {
					db.close();
				} finally {
					if (this.openStorages.get(key) === storage) this.openStorages.delete(key);
					this.openSessions.delete(openSession);
					this.pendingIds.delete(metadata.id);
				}
			},
		});
		this.openSessions.add(openSession);
		return openSession;
	}

	private async repositoryPathForMetadata(metadata: SqliteSessionMetadata): Promise<string> {
		const [expected, actual] = await Promise.all([
			realpath(this.pathForSession(metadata.id)),
			realpath(metadata.path),
		]);
		if (expected !== actual) {
			throw new Error(`SQLite session metadata path is outside this repository: ${metadata.path}`);
		}
		return actual;
	}

	private reserveId(id: string): void {
		if (this.pendingIds.has(id)) throw new Error(`Session is already open: ${id}`);
		this.pendingIds.add(id);
	}

	private pathForSession(id: string): string {
		return this.databasePath ?? sessionPath(this.directory, id);
	}

	private usesSharedDatabase(): boolean {
		return this.databasePath !== undefined;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteSessionRepo is closed");
	}
}
