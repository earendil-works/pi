import { dirname, resolve } from "node:path";
import type { Session } from "@earendil-works/pi-agent-core";
import { SessionError } from "@earendil-works/pi-agent-core";
import {
	type SqliteSessionCreateOptions,
	type SqliteSessionMetadata,
	SqliteSessionRepo,
} from "@earendil-works/pi-agent-core/sqlite";
import { SqliteNodeExecutionEnv } from "@earendil-works/pi-agent-core/sqlite/env/node";
import type { SessionInfo, SessionReference } from "./session-manager.ts";

export const SQLITE_SESSIONS_DATABASE = "sessions.sqlite";

/** Coding-agent lifecycle adapter around agent-core's SQLite repository. */
export class CodingAgentSqliteSessionRepository {
	readonly databasePath: string;
	private readonly repo: SqliteSessionRepo;

	constructor(databasePath: string) {
		this.databasePath = resolve(databasePath);
		const env = new SqliteNodeExecutionEnv({ cwd: dirname(this.databasePath) });
		this.repo = new SqliteSessionRepo({ env, databasePath: this.databasePath });
	}

	toReference(metadata: SqliteSessionMetadata): SessionReference {
		return { backend: "sqlite", id: metadata.id, storagePath: metadata.path };
	}

	create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>> {
		return this.repo.create(options);
	}

	async openById(id: string): Promise<Session<SqliteSessionMetadata>> {
		const metadata = (await this.repo.list()).find((candidate) => candidate.id === id);
		if (!metadata) throw new SessionError("not_found", `Session not found: ${id}`);
		return this.repo.open(metadata);
	}

	list(cwd?: string): Promise<SqliteSessionMetadata[]> {
		return this.repo.list(cwd ? { cwd: resolve(cwd) } : {});
	}

	async listSessionInfo(cwd?: string): Promise<SessionInfo[]> {
		return (await this.list(cwd)).map((metadata) => ({
			path: `${metadata.path}#${metadata.id}`,
			id: metadata.id,
			reference: this.toReference(metadata),
			cwd: metadata.cwd,
			name: metadata.name,
			parentReference: metadata.parentSessionId
				? { backend: "sqlite", id: metadata.parentSessionId, storagePath: metadata.path }
				: undefined,
			created: new Date(metadata.createdAt),
			modified: new Date(metadata.updatedAt ?? metadata.createdAt),
			messageCount: metadata.messageCount ?? 0,
			firstMessage: metadata.firstMessage ?? "(no messages)",
			allMessagesText: metadata.allMessagesText ?? "",
		}));
	}

	async continueRecent(cwd: string): Promise<Session<SqliteSessionMetadata>> {
		const resolvedCwd = resolve(cwd);
		const recent = (await this.list(resolvedCwd))[0];
		return recent ? this.repo.open(recent) : this.repo.create({ cwd: resolvedCwd });
	}

	async deleteById(id: string): Promise<void> {
		const session = await this.openById(id);
		const metadata = await session.getMetadata();
		await session.close();
		await this.repo.delete(metadata);
	}

	async fork(
		sourceId: string,
		options: SqliteSessionCreateOptions & { entryId?: string; position?: "before" | "at" },
	): Promise<Session<SqliteSessionMetadata>> {
		const source = await this.openById(sourceId);
		try {
			return await this.repo.fork(await source.getMetadata(), options);
		} finally {
			await source.close();
		}
	}

	/** Remove a lazily-created session if no message was ever persisted. */
	async discardIfEmpty(session: Session<SqliteSessionMetadata>): Promise<boolean> {
		const metadata = await session.getMetadata();
		const { messageCount } = await session.getSessionStats();
		await session.close();
		if (messageCount !== 0) return false;
		await this.repo.delete(metadata);
		return true;
	}
}
