import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	Session,
	SessionStorage,
	SqliteSessionMetadata,
} from "../types.ts";
import { SessionError } from "../types.ts";
import type { JsonlSessionRepo } from "./jsonl-repo.ts";
import { toSession } from "./repo-utils.ts";
import { isExperimentalSqliteSessionStorageEnabled } from "./sqlite/experimental.ts";
import type { SqliteSessionRepo } from "./sqlite/repo.ts";

export class SessionLifecycle {
	private readonly jsonlRepo: JsonlSessionRepo;
	private readonly sqliteRepo?: SqliteSessionRepo;

	constructor(options: { jsonlRepo: JsonlSessionRepo; sqliteRepo?: SqliteSessionRepo }) {
		this.jsonlRepo = options.jsonlRepo;
		this.sqliteRepo = options.sqliteRepo;
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const session = await this.jsonlRepo.create(options);
		const sqliteStorage = await this.createOrBackfillSqliteStorage(session);
		return this.attachSqliteStorage(session, sqliteStorage);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		const session = await this.jsonlRepo.open(metadata);
		const sqliteStorage = await this.openOrBackfillSqliteStorage(session);
		return this.attachSqliteStorage(session, sqliteStorage);
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		return this.jsonlRepo.list(options);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		await this.jsonlRepo.delete(metadata);
		if (!isExperimentalSqliteSessionStorageEnabled()) return;
		const sqliteMetadata = await this.findSqliteMetadata(metadata);
		if (sqliteMetadata) {
			await this.requireSqliteRepo().delete(sqliteMetadata);
		}
	}

	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<JsonlSessionMetadata>> {
		const session = await this.jsonlRepo.fork(sourceMetadata, options);
		const sqliteStorage = await this.createOrBackfillSqliteStorage(session, { parentSessionId: sourceMetadata.id });
		return this.attachSqliteStorage(session, sqliteStorage);
	}

	private attachSqliteStorage(
		session: Session<JsonlSessionMetadata>,
		sqliteStorage?: SessionStorage<SqliteSessionMetadata>,
	): Session<JsonlSessionMetadata> {
		if (!sqliteStorage) return session;
		return toSession(session.getStorage(), sqliteStorage);
	}

	private requireSqliteRepo(): SqliteSessionRepo {
		if (!this.sqliteRepo) {
			throw new SessionError("storage", "SQLite session storage is not configured");
		}
		return this.sqliteRepo;
	}

	private async findSqliteMetadata(metadata: JsonlSessionMetadata): Promise<SqliteSessionMetadata | undefined> {
		const repo = this.requireSqliteRepo();
		return (await repo.list({ cwd: metadata.cwd })).find((session) => session.id === metadata.id);
	}

	private async createOrBackfillSqliteStorage(
		session: Session<JsonlSessionMetadata>,
		options?: { parentSessionId?: string },
	): Promise<SessionStorage<SqliteSessionMetadata> | undefined> {
		if (!isExperimentalSqliteSessionStorageEnabled()) return undefined;
		const repo = this.requireSqliteRepo();
		const metadata = await session.getMetadata();
		const sqliteSession = await repo.create({
			cwd: metadata.cwd,
			id: metadata.id,
			parentSessionId: options?.parentSessionId,
		});
		const sqliteStorage = sqliteSession.getStorage();
		for (const entry of await session.getEntries()) {
			await sqliteStorage.appendEntry(entry);
		}
		return sqliteStorage;
	}

	private async openOrBackfillSqliteStorage(
		session: Session<JsonlSessionMetadata>,
	): Promise<SessionStorage<SqliteSessionMetadata> | undefined> {
		if (!isExperimentalSqliteSessionStorageEnabled()) return undefined;
		const metadata = await session.getMetadata();
		const existing = await this.findSqliteMetadata(metadata);
		if (existing) {
			return (await this.requireSqliteRepo().open(existing)).getStorage();
		}
		return this.createOrBackfillSqliteStorage(session);
	}
}
