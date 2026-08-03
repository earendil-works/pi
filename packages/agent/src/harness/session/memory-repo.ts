import type {
	SessionForkOptions,
	SessionForkSelection,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";
import { ArraySessionIndex } from "./array-session-index.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import {
	createSessionForkSelection,
	createSessionId,
	createTimestamp,
	readSessionEntriesForFork,
	type SessionRepository,
} from "./repository.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

export type InMemorySessionCreateOptions = { id?: string };

interface InMemorySessionState {
	metadata: SessionMetadata;
	entries: ArraySessionIndex;
}

export class InMemorySessionBackend {
	private readonly sessions = new Map<string, InMemorySessionState>();
	private readonly operations = new KeyedOperationQueue<string>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	create(options: InMemorySessionCreateOptions = {}): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		return this.operations.enqueue(id, () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new ArraySessionIndex(),
			};
			this.sessions.set(id, state);
			return this.storage(state);
		});
	}

	open(metadata: SessionMetadata): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => this.storage(this.getState(metadata)));
	}

	list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => [...this.sessions.values()].map((state) => state.metadata));
	}

	delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.sessions.delete(metadata.id);
		});
	}

	fork(
		source: SessionMetadata,
		options: InMemorySessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		const sourceEntries = this.operations.enqueue(source.id, () =>
			readSessionEntriesForFork(this.getState(source).entries, selection),
		);
		return this.operations.enqueue(id, async () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new ArraySessionIndex(await sourceEntries),
			};
			this.sessions.set(id, state);
			return this.storage(state);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	private storage(state: InMemorySessionState): SessionStorage<SessionMetadata> {
		const read = <T>(operation: (entries: ArraySessionIndex) => T): Promise<T> => {
			this.assertOpen();
			return this.operations.enqueue(state.metadata.id, () => operation(this.getState(state.metadata).entries));
		};
		return {
			metadata: state.metadata,
			readHead: () => read((entries) => entries.readHead()),
			readEntry: (id) => read((entries) => entries.readEntry(id)),
			readEntries: (options) => read((entries) => entries.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(state.metadata, entry),
			findEntriesOnBranch: (query) => read((entries) => entries.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) => read((entries) => entries.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => read((entries) => entries.getLabel(id)),
			getName: () => read((entries) => entries.getName()),
			getStats: () => read((entries) => entries.getStats()),
		};
	}

	private appendEntry(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.getState(metadata).entries.append(entry);
		});
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "In-memory session repository is disposed");
	}

	private getState(metadata: SessionMetadata): InMemorySessionState {
		const state = this.sessions.get(metadata.id);
		if (!state) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return state;
	}
}

export interface InMemorySessionRepositoryOptions {
	contextBuildOptions?: SessionContextBuildOptions;
}

export class InMemorySessionRepository
	implements SessionRepository<SessionMetadata, InMemorySessionCreateOptions, void>
{
	private readonly backend = new InMemorySessionBackend();
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(options: InMemorySessionRepositoryOptions = {}) {
		this.contextBuildOptions = options.contextBuildOptions ?? {};
	}

	async create(options: InMemorySessionCreateOptions = {}): Promise<Session<SessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	async list(): Promise<SessionMetadata[]> {
		return await this.backend.list();
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	async fork(
		source: SessionMetadata,
		options: SessionForkOptions & InMemorySessionCreateOptions,
	): Promise<Session<SessionMetadata>> {
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
