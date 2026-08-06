import { uuidv7 } from "@earendil-works/pi-ai";
import { assertJsonSerializable, Session } from "../session.ts";
import { type Entry, type ForkOptions, type LanePointer, SessionError, type SessionRepo } from "../types.ts";
import { publishFileAtomically } from "./atomic.ts";
import { encodeHeader, metadataFromHeader, parseHeader } from "./codec.ts";
import { fileResult, invalidFile } from "./errors.ts";
import { JsonlSessionStorage } from "./storage.ts";
import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoFileSystem,
	JsonlSessionRepoOptions,
	JsonlV4Header,
} from "./types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError(
			"invalid_payload",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

function sessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
}

export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private rootPromise: Promise<string> | undefined;

	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		return this.createDirect(options);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return this.openDirect(metadata);
	}

	list(): Promise<JsonlSessionMetadata[]>;
	list(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]>;
	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		return this.listDirect(options);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		fileResult(await this.fs.remove(metadata.path, { force: true }), `Failed to delete session ${metadata.path}`);
	}

	async fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const sourceSession = await this.openDirect(source);
		let copiedEntries: Entry[];
		let forkLanes: LanePointer[];
		if (options.scope === "tree") {
			copiedEntries = await sourceSession.findEntries({ order: "oldestFirst" });
			forkLanes = await sourceSession.getLanes();
		} else {
			const selectedEntryId = options.entryId ?? (await sourceSession.getLeafId());
			let targetId: string | null = null;
			if (selectedEntryId !== null) {
				const entry = await sourceSession.getEntry(selectedEntryId);
				if (!entry || entry.type !== "message") {
					throw new SessionError("invalid_fork_target", `Fork target is not a message entry: ${selectedEntryId}`);
				}
				const position = options.position ?? (options.entryId === undefined ? "at" : "before");
				targetId = position === "at" ? entry.id : entry.parentId;
			}
			copiedEntries =
				targetId === null ? [] : await sourceSession.findEntriesOnBranch({ start: targetId, order: "oldestFirst" });
			forkLanes = [{ lane: "main", leafId: targetId }];
		}

		const { header, path } = await this.prepareCreate({
			...options,
			parentSessionId: options.parentSessionId ?? source.id,
		});
		await publishFileAtomically(this.fs, path, async (tempPath) => {
			fileResult(await this.fs.writeFile(tempPath, encodeHeader(header)), `Failed to stage fork ${path}`);
			const fileInfo = fileResult(await this.fs.fileInfo(tempPath), `Failed to read staged fork metadata ${path}`);
			const targetStorage = new JsonlSessionStorage(this.fs, metadataFromHeader(header, tempPath, fileInfo.mtimeMs));
			for (const entry of copiedEntries) await targetStorage.appendCopiedEntry(entry);
			for (const pointer of forkLanes) await targetStorage.appendForkLane(pointer.lane, pointer.leafId);
			const name = await sourceSession.getName();
			if (name !== undefined) await targetStorage.setName(name);
			for (const entry of copiedEntries) {
				const label = await sourceSession.getLabel(entry.id);
				if (label !== undefined) await targetStorage.setLabel(entry.id, label);
			}
		});
		return new Session(await JsonlSessionStorage.load(this.fs, path));
	}

	private async openDirect(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		if (!fileResult(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const storage = await JsonlSessionStorage.load(this.fs, metadata.path);
		const loadedMetadata = await storage.getMetadata();
		if (loadedMetadata.id !== metadata.id) {
			throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
		}
		return new Session(storage);
	}

	private async createDirect(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const { header, path } = await this.prepareCreate(options);
		fileResult(await this.fs.writeFile(path, encodeHeader(header)), `Failed to create session ${path}`);
		const fileInfo = fileResult(await this.fs.fileInfo(path), `Failed to read session metadata ${path}`);
		return new Session(new JsonlSessionStorage(this.fs, metadataFromHeader(header, path, fileInfo.mtimeMs)));
	}

	private async prepareCreate(options: JsonlSessionCreateOptions): Promise<{
		header: JsonlV4Header;
		path: string;
	}> {
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		// Skip the repository-wide scan for generated UUIDv7 ids because their collision risk is negligible.
		if (options.id !== undefined && (await this.sessionIdExists(id))) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

		const cwd = fileResult(await this.fs.absolutePath(options.cwd), `Failed to resolve session cwd ${options.cwd}`);
		const createdAt = Date.now();
		const sessionDirectory = await this.sessionDirectory(cwd);
		const path = fileResult(
			await this.fs.joinPath([sessionDirectory, sessionFileName(createdAt, id)]),
			`Failed to resolve path for session ${id}`,
		);
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt,
			cwd,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		fileResult(await this.fs.createDir(sessionDirectory, { recursive: true }), `Failed to create sessions directory`);
		return { header, path };
	}

	private async listDirect(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		const directories = await this.sessionDirectories(options.cwd);
		const metadata: JsonlSessionMetadata[] = [];
		for (const directory of directories) {
			const files = fileResult(
				await this.fs.listDir(directory),
				`Failed to list sessions directory ${directory}`,
			).filter((entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"));
			for (const file of files) {
				const content = fileResult(
					await this.fs.readTextFile(file.path),
					`Failed to read session header ${file.path}`,
				);
				const firstLine = content.split("\n", 1)[0];
				if (!firstLine) throw invalidFile(file.path, 1, "is missing a header");
				metadata.push(metadataFromHeader(parseHeader(firstLine, file.path), file.path, file.mtimeMs));
			}
		}
		return metadata.sort((left, right) => right.modifiedAt - left.modifiedAt);
	}

	private async sessionIdExists(id: string): Promise<boolean> {
		const suffix = `_${id}.jsonl`;
		for (const directory of await this.sessionDirectories()) {
			const files = fileResult(await this.fs.listDir(directory), `Failed to list sessions directory ${directory}`);
			if (files.some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix))) return true;
		}
		return false;
	}

	private async sessionDirectories(cwd?: string): Promise<string[]> {
		const root = await this.root();
		if (cwd !== undefined) {
			const resolvedCwd = fileResult(await this.fs.absolutePath(cwd), `Failed to resolve session cwd ${cwd}`);
			const directory = await this.sessionDirectory(resolvedCwd);
			return fileResult(await this.fs.exists(directory), `Failed to check sessions directory ${directory}`)
				? [directory]
				: [];
		}
		if (!fileResult(await this.fs.exists(root), `Failed to check sessions directory ${root}`)) return [];
		return fileResult(await this.fs.listDir(root), `Failed to list sessions directory ${root}`)
			.filter((entry) => entry.kind === "directory" || entry.kind === "symlink")
			.map((entry) => entry.path);
	}

	private async sessionDirectory(cwd: string): Promise<string> {
		return fileResult(
			await this.fs.joinPath([await this.root(), sessionDirectoryName(cwd)]),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}
}
