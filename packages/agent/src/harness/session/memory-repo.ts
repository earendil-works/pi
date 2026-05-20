import { type Session, SessionError, type SessionMetadata, type SessionRepo } from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import { createSessionId, createTimestamp, getEntriesToFork, toSession } from "./repo-utils.ts";

export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
	private sessions = new Map<string, Session<SessionMetadata>>();

	async create(options: { id?: string } = {}): Promise<Session<SessionMetadata>> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}

	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		const session = this.sessions.get(metadata.id);
		if (!session) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		return session;
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<SessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}
}
