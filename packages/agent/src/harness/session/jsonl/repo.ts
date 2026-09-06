import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import type { Context } from "../../context.ts";
import type { FileError, FileInfo, FileSystem, Result } from "../../types.ts";
import { createForkSnapshot, type ForkSourceSnapshot } from "../fork.ts";
import { StorageBackedSession } from "../session.ts";
import type { ForkOptions, Session, SessionRepo } from "../types.ts";
import { parseJsonlSessionHeader } from "./codec.ts";
import { metadataFromLegacyV3Header } from "./legacy-v3.ts";
import { JsonlStorage } from "./storage.ts";
import {
	JSONL_FORMAT_VERSION,
	JSONL_STORAGE_VERSION,
	type JsonlSessionCreateOptions,
	type JsonlSessionListOptions,
	type JsonlSessionMetadata,
	type JsonlSessionRepoOptions,
	type JsonlStorageHeader,
} from "./types.ts";

function fileValue<T>(result: Result<T, FileError>, action: string): T {
	if (!result.ok) throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
	return result.value;
}

function metadataFromHeader(header: JsonlStorageHeader, path: string, modifiedAt: number): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.createdAt,
		storageVersion: header.storageVersion,
		cwd: header.cwd,
		path,
		modifiedAt,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: header.legacyParentSessionPath }),
	};
}

function sessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${encodeURIComponent(id)}.jsonl`;
}

/** File-backed format-4 session repository lifecycle. */
export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly fileSystem: FileSystem;
	private readonly sessionsRootInput: string;
	private readonly now: () => number;
	private readonly openSessions = new Map<string, JsonlStorage>();
	private readonly pendingCreates = new Set<string>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: JsonlSessionRepoOptions) {
		this.fileSystem = options.fileSystem;
		this.sessionsRootInput = options.sessionsRoot;
		this.now = options.now ?? Date.now;
	}

	async create(options: JsonlSessionCreateOptions, context: Context): Promise<Session<JsonlSessionMetadata>> {
		this.assertOpen();
		const createdAt = this.now();
		const { cwd, id } = await this.resolveCreateDestination(options.cwd, options.id, createdAt, context);
		const key = this.sessionKey(cwd, id);
		if (this.openSessions.has(key) || this.pendingCreates.has(key)) throw new Error(`Session already exists: ${id}`);
		this.pendingCreates.add(key);
		let path: string | undefined;
		let storage: JsonlStorage | undefined;
		try {
			path = await this.resolveNewSessionPath(cwd, createdAt, id, context);
			const header: JsonlStorageHeader = {
				v: JSONL_FORMAT_VERSION,
				kind: "header",
				id,
				storageVersion: JSONL_STORAGE_VERSION,
				createdAt,
				cwd,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			};
			storage = await JsonlStorage.create({ fileSystem: this.fileSystem, path, now: this.now }, header, [], context);
			const info = fileValue(await this.fileSystem.fileInfo(path, context), `Failed to read session ${path}`);
			return this.publishOpenSession(metadataFromHeader(header, path, info.mtimeMs), storage, key);
		} catch (error) {
			await storage?.close(context).catch(() => undefined);
			if (path !== undefined) await this.fileSystem.remove(path, { force: true }, context);
			throw error;
		} finally {
			this.pendingCreates.delete(key);
		}
	}

	async open(metadata: JsonlSessionMetadata, context: Context): Promise<Session<JsonlSessionMetadata>> {
		this.assertOpen();
		const key = this.sessionKey(metadata.cwd, metadata.id);
		if (this.openSessions.has(key)) throw new Error(`Session is already open: ${metadata.id}`);
		let storage: JsonlStorage | undefined;
		try {
			storage = await this.loadStorage(metadata, context);
			return this.publishOpenSession(metadata, storage, key);
		} catch (error) {
			await storage?.close(context);
			throw error;
		}
	}

	async list(options: JsonlSessionListOptions | undefined, context: Context): Promise<JsonlSessionMetadata[]> {
		options ??= {};
		this.assertOpen();
		const cwd =
			options.cwd === undefined
				? undefined
				: fileValue(
						await this.fileSystem.absolutePath(options.cwd, context),
						`Failed to resolve session cwd ${options.cwd}`,
					);
		const root = await this.root(context);
		if (!fileValue(await this.fileSystem.exists(root, context), `Failed to check sessions root ${root}`)) return [];
		const directories =
			cwd === undefined ? await this.sessionDirectories(root, context) : [await this.sessionDirectory(cwd, context)];
		const metadata: JsonlSessionMetadata[] = [];
		for (const directory of directories) metadata.push(...(await this.listDirectory(directory, cwd, context)));
		return metadata.sort(
			(left, right) =>
				right.createdAt - left.createdAt || left.id.localeCompare(right.id) || left.cwd.localeCompare(right.cwd),
		);
	}

	async delete(metadata: JsonlSessionMetadata, context: Context): Promise<void> {
		this.assertOpen();
		const key = this.sessionKey(metadata.cwd, metadata.id);
		if (this.openSessions.has(key)) throw new Error(`Session is open: ${metadata.id}`);
		if (
			!fileValue(await this.fileSystem.exists(metadata.path, context), `Failed to check session ${metadata.path}`)
		) {
			throw new Error(`Session file does not exist: ${metadata.path}`);
		}
		fileValue(
			await this.fileSystem.remove(metadata.path, undefined, context),
			`Failed to delete session ${metadata.path}`,
		);
	}

	async fork(
		source: JsonlSessionMetadata,
		options: ForkOptions,
		context: Context,
	): Promise<Session<JsonlSessionMetadata>> {
		this.assertOpen();
		const createdAt = this.now();
		const sourceStorage = this.openSessions.get(this.sessionKey(source.cwd, source.id));
		const sourceSnapshot = await (sourceStorage === undefined
			? this.loadClosedForkSourceSnapshot(source, context)
			: sourceStorage.captureForkSource(context));
		const { cwd, id } = await this.resolveCreateDestination(source.cwd, options.id, createdAt, context);
		const destinationKey = this.sessionKey(cwd, id);
		if (this.openSessions.has(destinationKey) || this.pendingCreates.has(destinationKey)) {
			throw new Error(`Session already exists: ${id}`);
		}
		this.pendingCreates.add(destinationKey);

		let path: string | undefined;
		let storage: JsonlStorage | undefined;
		try {
			path = await this.resolveNewSessionPath(cwd, createdAt, id, context);
			const snapshot = createForkSnapshot(sourceSnapshot, options);
			const header: JsonlStorageHeader = {
				v: JSONL_FORMAT_VERSION,
				kind: "header",
				id,
				storageVersion: JSONL_STORAGE_VERSION,
				createdAt,
				cwd,
				parentSessionId: source.id,
			};
			storage = await JsonlStorage.createFromForkSnapshot(
				{ fileSystem: this.fileSystem, path, now: this.now },
				header,
				snapshot,
				context,
			);
			const info = fileValue(await this.fileSystem.fileInfo(path, context), `Failed to read session ${path}`);
			return this.publishOpenSession(metadataFromHeader(header, path, info.mtimeMs), storage, destinationKey);
		} catch (error) {
			await storage?.close(context).catch(() => undefined);
			if (path !== undefined) await this.fileSystem.remove(path, { force: true }, context);
			throw error;
		} finally {
			this.pendingCreates.delete(destinationKey);
		}
	}

	close(_context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		// TODO: Define ownership semantics before deciding whether repository close should close session handles.
		this.closePromise = Promise.resolve();
		return this.closePromise;
	}

	private async resolveCreateDestination(
		cwdInput: string,
		id: string | undefined,
		createdAt: number,
		context: Context,
	): Promise<{ cwd: string; id: string }> {
		const destinationId = id ?? uuidv7(createdAt);
		const cwd = fileValue(
			await this.fileSystem.absolutePath(cwdInput, context),
			`Failed to resolve session cwd ${cwdInput}`,
		);
		return { cwd, id: destinationId };
	}

	private async listDirectory(
		directory: string,
		cwd: string | undefined,
		context: Context,
	): Promise<JsonlSessionMetadata[]> {
		if (
			!fileValue(await this.fileSystem.exists(directory, context), `Failed to check sessions directory ${directory}`)
		) {
			return [];
		}
		const files = fileValue(
			await this.fileSystem.listDir(directory, context),
			`Failed to list sessions directory ${directory}`,
		).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
		const metadata: JsonlSessionMetadata[] = [];
		for (const file of files) {
			const discovered = await this.readSessionMetadata(file, context);
			if (discovered === undefined) continue;
			// Directory encoding is lossy: /a/b and /a-b both map to --a-b--.
			if (cwd === undefined || discovered.cwd === cwd) metadata.push(discovered);
		}
		return metadata;
	}

	private async readSessionMetadata(file: FileInfo, context: Context): Promise<JsonlSessionMetadata | undefined> {
		const lines = fileValue(
			await this.fileSystem.readTextLines(file.path, { maxLines: 1 }, context),
			`Failed to read session header ${file.path}`,
		);
		if (lines[0] === undefined) return undefined;
		const parsedHeader = parseJsonlSessionHeader(lines[0]);
		if (!parsedHeader.ok) return undefined;
		if (parsedHeader.value.format === "v3-legacy") {
			const metadata = await metadataFromLegacyV3Header(this.fileSystem, parsedHeader.value.header, context);
			return { ...metadata, path: file.path, modifiedAt: file.mtimeMs };
		}
		return metadataFromHeader(parsedHeader.value.header, file.path, file.mtimeMs);
	}

	private async sessionDirectories(root: string, context: Context): Promise<string[]> {
		return fileValue(await this.fileSystem.listDir(root, context), `Failed to list sessions root ${root}`)
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}

	private async sessionDirectory(cwd: string, context: Context): Promise<string> {
		return fileValue(
			await this.fileSystem.joinPath([await this.root(context), sessionDirectoryName(cwd)], context),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	private async resolveNewSessionPath(cwd: string, createdAt: number, id: string, context: Context): Promise<string> {
		const directory = await this.sessionDirectory(cwd, context);
		await this.assertSessionIdAvailable(directory, id, context);
		fileValue(
			await this.fileSystem.createDir(directory, undefined, context),
			`Failed to create sessions directory ${directory}`,
		);
		return fileValue(
			await this.fileSystem.joinPath([directory, sessionFileName(createdAt, id)], context),
			`Failed to resolve path for session ${id}`,
		);
	}

	private async assertSessionIdAvailable(directory: string, id: string, context: Context): Promise<void> {
		if (
			!fileValue(await this.fileSystem.exists(directory, context), `Failed to check sessions directory ${directory}`)
		)
			return;

		const suffix = `_${encodeURIComponent(id)}.jsonl`;
		const idExists = fileValue(
			await this.fileSystem.listDir(directory, context),
			`Failed to list sessions directory ${directory}`,
		).some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
		if (idExists) throw new Error(`Session already exists: ${id}`);
	}

	private async loadClosedForkSourceSnapshot(
		source: JsonlSessionMetadata,
		context: Context,
	): Promise<ForkSourceSnapshot> {
		const storage = await this.loadStorage(source, context);
		try {
			return await storage.captureForkSource(context);
		} finally {
			await storage.close(context);
		}
	}

	private publishOpenSession(
		metadata: JsonlSessionMetadata,
		storage: JsonlStorage,
		key: string,
	): StorageBackedSession<JsonlSessionMetadata> {
		if (this.openSessions.has(key)) throw new Error(`Session is already open: ${metadata.id}`);
		const session = new StorageBackedSession(metadata, storage, {
			onClose: () => {
				if (this.openSessions.get(key) === storage) this.openSessions.delete(key);
			},
		});
		this.openSessions.set(key, storage);
		return session;
	}

	private sessionKey(cwd: string, id: string): string {
		return `${cwd}\0${id}`;
	}

	private async loadStorage(metadata: JsonlSessionMetadata, context: Context): Promise<JsonlStorage> {
		if (
			!fileValue(await this.fileSystem.exists(metadata.path, context), `Failed to check session ${metadata.path}`)
		) {
			throw new Error(`Session file does not exist: ${metadata.path}`);
		}
		const storage = await JsonlStorage.open(
			{
				fileSystem: this.fileSystem,
				path: metadata.path,
				now: this.now,
			},
			context,
		);
		try {
			if (storage.header.id !== metadata.id || storage.header.cwd !== metadata.cwd) {
				throw new Error(`Session identity does not match header: ${metadata.id}`);
			}
			if (storage.header.storageVersion !== JSONL_STORAGE_VERSION) {
				throw new Error(`Session ${metadata.id} uses unsupported storage version ${storage.header.storageVersion}`);
			}
			return storage;
		} catch (error) {
			await storage.close(context);
			throw error;
		}
	}

	private root(context: Context): Promise<string> {
		return this.fileSystem
			.absolutePath(this.sessionsRootInput, context)
			.then((result) => fileValue(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("JsonlSessionRepo is closed");
	}
}
