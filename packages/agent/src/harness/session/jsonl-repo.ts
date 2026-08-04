import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	SessionForkOptions,
	SessionForkSelection,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { ArraySessionIndex } from "./array-session-index.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import {
	createSessionForkSelection,
	createSessionId,
	createTimestamp,
	getFileSystemResultOrThrow,
	readSessionEntriesForFork,
	type SessionRepository,
} from "./repository.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

export interface JsonlSessionBackendOptions {
	fs: JsonlSessionRepositoryFileSystem;
	sessionsRoot: string;
	/** Maximum active operations across session keys. Defaults to 4. */
	maxConcurrentOperations?: number;
}
export type JsonlSessionRepositoryFileSystem = Pick<
	FileSystem,
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

type JsonlSessionFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

const DEFAULT_MAX_CONCURRENT_OPERATIONS = 4;

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

interface SessionDocumentDescriptor {
	id: string;
	timestamp: string;
	fileName: string;
	operationKey: string;
}

interface JsonlSessionDocument {
	metadata: JsonlSessionMetadata;
	entries: SessionTreeEntry[];
}

function invalidSession(path: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${path}: ${message}`, cause);
}

function invalidEntry(path: string, line: number, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL session file ${path}: line ${line} ${message}`, cause);
}

function parseHeader(line: string, path: string): SessionHeader {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidSession(path, "first line is not a valid session header", toError(error));
	}
	if (typeof value !== "object" || value === null)
		throw invalidSession(path, "first line is not a valid session header");
	const header = value as Partial<SessionHeader>;
	if (header.type !== "session" || header.version !== 3) {
		throw invalidSession(
			path,
			header.type === "session" ? "unsupported session version" : "first line is not a valid session header",
		);
	}
	if (typeof header.id !== "string" || !header.id) throw invalidSession(path, "session header is missing id");
	if (typeof header.timestamp !== "string" || !header.timestamp)
		throw invalidSession(path, "session header is missing timestamp");
	if (typeof header.cwd !== "string" || !header.cwd) throw invalidSession(path, "session header is missing cwd");
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw invalidSession(path, "session header parentSession must be a string");
	}
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(path, "session header metadata must be an object");
	}
	return {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		parentSession: header.parentSession,
		metadata: header.metadata,
	};
}

function parseEntry(line: string, path: string, lineNumber: number): SessionTreeEntry {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(path, lineNumber, "is not valid JSON", toError(error));
	}
	if (typeof value !== "object" || value === null)
		throw invalidEntry(path, lineNumber, "is not a valid session entry");
	const entry = value as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		timestamp?: unknown;
		targetId?: unknown;
	};
	if (typeof entry.type !== "string") throw invalidEntry(path, lineNumber, "is missing entry type");
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(path, lineNumber, "is missing entry id");
	if (entry.parentId !== null && typeof entry.parentId !== "string")
		throw invalidEntry(path, lineNumber, "has invalid parentId");
	if (typeof entry.timestamp !== "string" || !entry.timestamp)
		throw invalidEntry(path, lineNumber, "is missing timestamp");
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(path, lineNumber, "has invalid targetId");
	}
	return entry as SessionTreeEntry;
}

function metadataFromHeader(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
		metadata: header.metadata,
	};
}

export async function loadJsonlSessionMetadata(
	fs: JsonlSessionFileSystem,
	path: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(path, { maxLines: 1 }),
		`Failed to read session header ${path}`,
	);
	if (!lines[0]?.trim()) throw invalidSession(path, "missing session header");
	return metadataFromHeader(parseHeader(lines[0], path), path);
}

async function loadJsonlSession(fs: JsonlSessionFileSystem, path: string): Promise<JsonlSessionDocument> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(path), `Failed to read session ${path}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) throw invalidSession(path, "missing session header");
	const header = parseHeader(lines[0]!, path);
	const entries = lines.slice(1).map((line, index) => parseEntry(line, path, index + 2));
	const entryIds = new Set<string>();
	for (const entry of entries) {
		if (entryIds.has(entry.id)) throw invalidSession(path, `duplicate entry id ${entry.id}`);
		entryIds.add(entry.id);
	}
	return {
		metadata: metadataFromHeader(header, path),
		entries,
	};
}

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function createDocumentDescriptor(options: JsonlSessionCreateOptions): SessionDocumentDescriptor {
	const id = options.id ?? createSessionId();
	if (!id) throw new SessionError("invalid_session", "Session id cannot be empty");
	let encodedId: string;
	try {
		encodedId = encodeURIComponent(id);
	} catch (error) {
		throw new SessionError("invalid_session", `Invalid session id ${JSON.stringify(id)}`, toError(error));
	}
	const timestamp = createTimestamp();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_${encodedId}.jsonl`;
	return {
		id,
		timestamp,
		fileName,
		operationKey: `document:${JSON.stringify([encodeCwd(options.cwd), fileName])}`,
	};
}

export class JsonlSessionBackend {
	private readonly fs: JsonlSessionRepositoryFileSystem;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;
	private readonly entryIndexesByPath = new Map<string, ArraySessionIndex>();
	private readonly operationKeysByPath = new Map<string, string>();
	private readonly operations: KeyedOperationQueue<string>;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: JsonlSessionBackendOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
		this.operations = new KeyedOperationQueue({
			maxConcurrentOperations: options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS,
		});
	}

	create(options: JsonlSessionCreateOptions): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		const descriptor = createDocumentDescriptor(options);
		return this.operations.enqueue(descriptor.operationKey, async () =>
			this.storage(await this.createDocument(descriptor, options, options.parentSessionPath, options.metadata, [])),
		);
	}

	open(metadata: JsonlSessionMetadata): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () =>
			this.storage(await this.loadDocument(metadata)),
		);
	}

	private async loadDocument(metadata: JsonlSessionMetadata): Promise<JsonlSessionMetadata> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		const document = await loadJsonlSession(this.fs, metadata.path);
		const entries = this.entryIndexesByPath.get(metadata.path);
		if (entries) entries.replace(document.entries);
		else this.entryIndexesByPath.set(metadata.path, new ArraySessionIndex(document.entries));
		return document.metadata;
	}

	list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => this.listSessions(options));
	}

	private async listSessions(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`))
				continue;
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
		}
		return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	}

	private appendEntry(metadata: JsonlSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			if (
				!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
			) {
				throw new SessionError("not_found", `Session not found: ${metadata.path}`);
			}
			let entries = this.entryIndexesByPath.get(metadata.path);
			if (!entries) {
				await this.loadDocument(metadata);
				entries = this.entryIndexesByPath.get(metadata.path)!;
			}
			if (entries.has(entry.id)) throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			getFileSystemResultOrThrow(
				await this.fs.appendFile(metadata.path, `${JSON.stringify(entry)}\n`),
				`Failed to append session entry ${entry.id}`,
			);
			entries.append(entry);
		});
	}

	delete(metadata: JsonlSessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			getFileSystemResultOrThrow(
				await this.fs.remove(metadata.path, { force: true }),
				`Failed to delete session ${metadata.path}`,
			);
			this.entryIndexesByPath.delete(metadata.path);
			this.operationKeysByPath.delete(metadata.path);
		});
	}

	fork(
		source: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		const descriptor = createDocumentDescriptor(options);
		const sourceEntries = this.operations.enqueue(this.operationKey(source), async () => {
			if (!getFileSystemResultOrThrow(await this.fs.exists(source.path), `Failed to check session ${source.path}`)) {
				throw new SessionError("not_found", `Session not found: ${source.path}`);
			}
			const document = await loadJsonlSession(this.fs, source.path);
			const entries = this.entryIndexesByPath.get(source.path);
			if (entries) entries.replace(document.entries);
			else this.entryIndexesByPath.set(source.path, new ArraySessionIndex(document.entries));
			return readSessionEntriesForFork(this.entryIndexesByPath.get(source.path)!, selection);
		});
		return this.operations.enqueue(descriptor.operationKey, async () =>
			this.storage(
				await this.createDocument(
					descriptor,
					options,
					options.parentSessionPath ?? source.path,
					options.metadata ?? source.metadata,
					await sourceEntries,
				),
			),
		);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "JSONL session repository is disposed");
	}

	private operationKey(metadata: JsonlSessionMetadata): string {
		return this.operationKeysByPath.get(metadata.path) ?? metadata.path;
	}

	private async createDocument(
		descriptor: SessionDocumentDescriptor,
		options: JsonlSessionCreateOptions,
		parentSessionPath: string | undefined,
		metadata: Record<string, unknown> | undefined,
		entries: readonly SessionTreeEntry[],
	): Promise<JsonlSessionMetadata> {
		const dir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(dir, { recursive: true }),
			`Failed to create session directory ${dir}`,
		);
		const path = getFileSystemResultOrThrow(
			await this.fs.joinPath([dir, descriptor.fileName]),
			`Failed to resolve session file path for ${descriptor.id}`,
		);
		if (getFileSystemResultOrThrow(await this.fs.exists(path), `Failed to check session ${path}`)) {
			throw new SessionError("invalid_session", `Session already exists: ${path}`);
		}
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: descriptor.id,
			timestamp: descriptor.timestamp,
			cwd: options.cwd,
			parentSession: parentSessionPath,
			metadata,
		};
		const content = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n");
		getFileSystemResultOrThrow(await this.fs.writeFile(path, content), `Failed to create session ${path}`);
		this.entryIndexesByPath.set(path, new ArraySessionIndex(entries));
		this.operationKeysByPath.set(path, descriptor.operationKey);
		return metadataFromHeader(header, path);
	}

	private readIndex<T>(metadata: JsonlSessionMetadata, read: (entries: ArraySessionIndex) => T): Promise<T> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), () => read(this.entryIndex(metadata.path)));
	}

	private storage(metadata: JsonlSessionMetadata): SessionStorage<JsonlSessionMetadata> {
		return {
			metadata,
			readHead: () => this.readIndex(metadata, (entries) => entries.readHead()),
			readEntry: (id) => this.readIndex(metadata, (entries) => entries.readEntry(id)),
			readEntries: (options) => this.readIndex(metadata, (entries) => entries.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(metadata, entry),
			findEntriesOnBranch: (query) => this.readIndex(metadata, (entries) => entries.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) =>
				this.readIndex(metadata, (entries) => entries.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => this.readIndex(metadata, (entries) => entries.getLabel(id)),
			getName: () => this.readIndex(metadata, (entries) => entries.getName()),
			getStats: () => this.readIndex(metadata, (entries) => entries.getStats()),
		};
	}

	private entryIndex(path: string): ArraySessionIndex {
		const entries = this.entryIndexesByPath.get(path);
		if (!entries) throw new SessionError("not_found", `Session not found: ${path}`);
		return entries;
	}

	private async getSessionsRoot(): Promise<string> {
		this.sessionsRoot ??= getFileSystemResultOrThrow(
			await this.fs.absolutePath(this.sessionsRootInput),
			`Failed to resolve sessions root ${this.sessionsRootInput}`,
		);
		return this.sessionsRoot;
	}

	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async listSessionDirs(): Promise<string[]> {
		const root = await this.getSessionsRoot();
		if (!getFileSystemResultOrThrow(await this.fs.exists(root), `Failed to check sessions root ${root}`)) return [];
		return getFileSystemResultOrThrow(await this.fs.listDir(root), `Failed to list sessions root ${root}`)
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}
}

export interface JsonlSessionRepositoryOptions extends JsonlSessionBackendOptions {
	contextBuildOptions?: SessionContextBuildOptions;
}

export class JsonlSessionRepository
	implements SessionRepository<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly backend: JsonlSessionBackend;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(options: JsonlSessionRepositoryOptions) {
		const { contextBuildOptions, ...backendOptions } = options;
		this.backend = new JsonlSessionBackend(backendOptions);
		this.contextBuildOptions = contextBuildOptions ?? {};
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	async list(options?: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		return await this.backend.list(options);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	async fork(
		source: JsonlSessionMetadata,
		options: SessionForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
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
