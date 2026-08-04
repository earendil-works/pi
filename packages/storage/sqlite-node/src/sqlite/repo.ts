import type {
	SessionForkOptions,
	SessionForkSelection,
	SessionRepository,
	SessionStorage,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	createSession,
	createSessionForkSelection,
	createSessionId,
	getFileSystemResultOrThrow,
	readSessionEntriesForFork,
	type Session,
	type SessionContextBuildOptions,
	SessionError,
} from "@earendil-works/pi-agent-core";
import { applyMigrations } from "./migrations.ts";
import { SqliteSessionConnection } from "./storage/index.ts";
import { rowToMetadata, type SessionRow } from "./storage/sessions.ts";
import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteSessionCreateOptions,
	SqliteSessionListOptions,
	SqliteSessionMetadata,
	SqliteSessionRepositoryEnv,
} from "./types.ts";

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

async function configureSqliteDatabase(db: SqliteDatabase): Promise<void> {
	await db.exec("PRAGMA journal_mode=WAL");
	await db.exec("PRAGMA synchronous=FULL");
	await db.exec("PRAGMA busy_timeout=5000");
}

export type SqliteSessionBackendOptions = {
	env: SqliteSessionRepositoryEnv;
	sqlite: SqliteDatabaseFactory;
	databasePath: string;
};

class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async drain(): Promise<void> {
		await this.tail;
	}
}

class SqliteSessionBackend {
	private readonly env: SqliteSessionRepositoryEnv;
	private readonly sqlite: SqliteDatabaseFactory;
	private readonly databasePathInput: string;
	private databasePath: string | undefined;
	private databasePromise: Promise<SqliteDatabase> | undefined;
	private database: SqliteDatabase | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private readonly operations = new SerialOperationQueue();
	private readonly writers = new Map<string, SqliteSessionConnection>();

	constructor(options: SqliteSessionBackendOptions) {
		this.env = options.env;
		this.sqlite = options.sqlite;
		this.databasePathInput = options.databasePath;
	}

	create(options: SqliteSessionCreateOptions): Promise<SessionStorage<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const path = await this.getDatabasePath();
			const connection = await db.transaction(() =>
				SqliteSessionConnection.create(db, path, {
					cwd: options.cwd,
					sessionId: options.id ?? createSessionId(),
					parentSessionId: options.parentSessionId,
					metadata: options.metadata,
				}),
			);
			this.writers.set(connection.metadata.id, connection);
			return this.storage(connection);
		});
	}

	open(metadata: SqliteSessionMetadata): Promise<SessionStorage<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(() => this.loadSession(metadata));
	}

	private async loadSession(metadata: SqliteSessionMetadata): Promise<SessionStorage<SqliteSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.env.exists(metadata.path), `Failed to check database ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const connection =
			this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
		this.writers.set(metadata.id, connection);
		return this.storage(connection);
	}

	list(options: SqliteSessionListOptions = {}): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueue(() => this.listSessions(options));
	}

	private async listSessions(options: SqliteSessionListOptions): Promise<SqliteSessionMetadata[]> {
		const path = await this.getDatabasePath();
		if (!getFileSystemResultOrThrow(await this.env.exists(path), `Failed to check database ${path}`)) return [];
		const db = await this.getDatabase();
		const rows = options.cwd
			? await db
					.prepare(
						"SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE cwd = ? ORDER BY created_at DESC",
					)
					.all<SessionRow>(options.cwd)
			: await db
					.prepare(
						"SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions ORDER BY created_at DESC",
					)
					.all<SessionRow>();
		return rows.map((row) => rowToMetadata(row, path));
	}

	private appendEntry(metadata: SqliteSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const connection =
				this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
			this.writers.set(metadata.id, connection);
			await connection.appendEntry(entry);
		});
	}

	delete(metadata: SqliteSessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			await db.transaction(async () => {
				await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM entry_materialized WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_materialized WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_sequences WHERE session_id = ?").run(metadata.id);
				const result = await db.prepare("DELETE FROM sessions WHERE id = ?").run(metadata.id);
				if (result.changes === 0) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
			});
			this.writers.delete(metadata.id);
		});
	}

	fork(
		source: SqliteSessionMetadata,
		options: SqliteSessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const connection = await db.transaction(async () => {
				const sourceConnection = this.writers.get(source.id) ?? (await SqliteSessionConnection.open(db, source));
				this.writers.set(source.id, sourceConnection);
				const entries = await readSessionEntriesForFork(sourceConnection, selection);
				const connection = await SqliteSessionConnection.create(db, await this.getDatabasePath(), {
					cwd: options.cwd,
					sessionId: options.id ?? createSessionId(),
					parentSessionId: options.parentSessionId ?? source.id,
					metadata: options.metadata ?? source.metadata,
				});
				for (const entry of entries) await connection.appendEntry(entry, { transaction: false });
				return connection;
			});
			this.writers.set(connection.metadata.id, connection);
			return this.storage(connection);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.finishDisposal();
		}
		await this.disposePromise;
	}

	private async finishDisposal(): Promise<void> {
		await this.operations.drain();
		const db = this.database ?? (this.databasePromise ? await this.databasePromise : undefined);
		this.database = undefined;
		this.databasePromise = undefined;
		this.writers.clear();
		if (db) await db.close();
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "SQLite session repository is disposed");
	}

	private storage(connection: SqliteSessionConnection): SessionStorage<SqliteSessionMetadata> {
		const metadata = connection.metadata;
		return {
			metadata,
			readHead: () => this.read(metadata, (current) => current.readHead()),
			readEntry: (id) => this.read(metadata, (current) => current.readEntry(id)),
			readEntries: (options) => this.read(metadata, (current) => current.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(metadata, entry),
			findEntriesOnBranch: (query) => this.read(metadata, (current) => current.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) =>
				this.read(metadata, (current) => current.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => this.read(metadata, (current) => current.getLabel(id)),
			getName: () => this.read(metadata, (current) => current.getName()),
			getStats: () => this.read(metadata, (current) => current.getStats()),
		};
	}

	private read<T>(
		metadata: SqliteSessionMetadata,
		read: (connection: SqliteSessionConnection) => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const connection =
				this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
			this.writers.set(metadata.id, connection);
			return read(connection);
		});
	}

	private async getDatabasePath(): Promise<string> {
		this.databasePath ??= getFileSystemResultOrThrow(
			await this.env.absolutePath(this.databasePathInput),
			`Failed to resolve SQLite sessions database ${this.databasePathInput}`,
		);
		return this.databasePath;
	}

	private async getDatabase(): Promise<SqliteDatabase> {
		if (!this.databasePromise) this.databasePromise = this.openDatabase();
		this.database = await this.databasePromise;
		return this.database;
	}

	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite sessions directory ${directory}`,
		);
		const db = await this.sqlite.open(path);
		try {
			await configureSqliteDatabase(db);
			await applyMigrations(db);
			return db;
		} catch (error) {
			await db.close();
			throw error;
		}
	}
}

export interface SqliteSessionRepositoryOptions extends SqliteSessionBackendOptions {
	contextBuildOptions?: SessionContextBuildOptions;
}

export class SqliteSessionRepository
	implements SessionRepository<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>
{
	private readonly backend: SqliteSessionBackend;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(options: SqliteSessionRepositoryOptions) {
		const { contextBuildOptions, ...backendOptions } = options;
		this.backend = new SqliteSessionBackend(backendOptions);
		this.contextBuildOptions = contextBuildOptions ?? {};
	}

	async create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	async list(options?: SqliteSessionListOptions): Promise<SqliteSessionMetadata[]> {
		return await this.backend.list(options);
	}

	async delete(metadata: SqliteSessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	async fork(
		source: SqliteSessionMetadata,
		options: SessionForkOptions & SqliteSessionCreateOptions,
	): Promise<Session<SqliteSessionMetadata>> {
		const { entryId: _entryId, position: _position, ...createOptions } = options;
		return createSession(
			await this.backend.fork(source, createOptions, createSessionForkSelection(options)),
			this.contextBuildOptions,
		);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.backend[Symbol.asyncDispose]();
	}
}
