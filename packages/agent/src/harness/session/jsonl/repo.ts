import { uuidv7 } from "@earendil-works/pi-ai";
import { assertJsonSerializable, Session } from "../session.ts";
import { type ForkOptions, SessionError, type SessionRepo } from "../types.ts";
import { metadataFromHeader, parseHeader } from "./codec.ts";
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
		const { header, path } = await this.prepareCreate(options);
		return new Session(await JsonlSessionStorage.create(this.fs, path, header));
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return new Session(await this.loadStorage(metadata));
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
		const sourceStorage = await this.loadStorage(source);
		const { header, path } = await this.prepareCreate({
			...options,
			parentSessionId: options.parentSessionId ?? source.id,
		});
		return new Session(await sourceStorage.fork(path, header, options));
	}

	private async loadStorage(metadata: JsonlSessionMetadata): Promise<JsonlSessionStorage> {
		if (!fileResult(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const storage = await JsonlSessionStorage.load(this.fs, metadata.path);
		const loadedMetadata = await storage.getMetadata();
		if (loadedMetadata.id !== metadata.id) {
			throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
		}
		return storage;
	}

	private async prepareCreate(options: JsonlSessionCreateOptions): Promise<{
		header: JsonlV4Header;
		path: string;
	}> {
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		const cwd = fileResult(await this.fs.absolutePath(options.cwd), `Failed to resolve session cwd ${options.cwd}`);
		if (await this.sessionIdExists(id, cwd)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

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

	private async sessionIdExists(id: string, cwd: string): Promise<boolean> {
		const suffix = `_${id}.jsonl`;
		const directory = await this.sessionDirectory(cwd);
		if (!fileResult(await this.fs.exists(directory), `Failed to check sessions directory ${directory}`)) return false;
		const files = fileResult(await this.fs.listDir(directory), `Failed to list sessions directory ${directory}`);
		return files.some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
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
