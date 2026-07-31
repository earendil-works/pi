import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionStoreApi,
	LeafEntry,
	SessionEntryCursorOptions,
	SessionSnapshot,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.ts";
import {
	createSessionId,
	createTimestamp,
	getEntriesToFork,
	getFileSystemResultOrThrow,
	SessionRepo,
} from "./repo-utils.ts";
import { ScanningSessionSearch } from "./search-backend.ts";

export type JsonlSessionStoreOptions = { fs: JsonlSessionStoreFileSystem; sessionsRoot: string };

export type JsonlSessionStoreFileSystem = Pick<
	FileSystem,
	| "cwd"
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

/**
 * 将工作目录路径编码为会话存储所需的文件系统安全目录名。
 * 去除前导斜杠/反斜杠，然后将每个路径分隔符（`/`、`\\`）和冒号（`:`）替换为连字符（`-`）。
 * 结果用双连字符分隔符包裹，使目录名清晰地标识一个已编码的 CWD。
 * @param cwd - 要编码的绝对工作目录路径。
 * @returns 适合在文件系统路径中使用的安全目录名。
 * @example encodeCwd("/home/user/project") // => "--home-user-project--"
 */
function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export class JsonlSessionStore implements JsonlSessionStoreApi {
	private readonly fs: JsonlSessionStoreFileSystem;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;

	constructor(options: JsonlSessionStoreOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	/**
	 * 解析并缓存会话根目录的绝对路径。
	 * @returns 会话根目录的绝对文件系统路径。
	 * @throws {SessionError} 如果路径无法解析。
	 */
	private async getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	/**
	 * 为给定工作目录计算会话目录路径。将会话根目录与编码后的 CWD 拼接。
	 * @param cwd - 需要获取会话目录的工作目录。
	 * @returns 每个 CWD 的会话目录的绝对路径。
	 * @throws {SessionError} 如果路径无法解析。
	 */
	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	/**
	 * 为新会话生成确定性 JSONL 文件路径。
	 * 文件名遵循 `<sanitizedTimestamp>_<sessionId>.jsonl` 模式，按创建时间字典序排序。
	 * @param cwd - 会话的工作目录。
	 * @param sessionId - 唯一会话标识符。
	 * @param timestamp - ISO-8601 创建时间戳。
	 * @returns 会话 JSONL 文件的绝对路径。
	 * @throws {SessionError} 如果路径无法解析。
	 */
	private async createSessionFilePath(cwd: string, sessionId: string, timestamp: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	async create(options: JsonlSessionCreateOptions): Promise<JsonlSessionMetadata> {
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
		const storage = await JsonlSessionStorage.create(this.fs, filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
			metadata: options.metadata,
		});
		return await storage.getMetadata();
	}

	async open(metadata: JsonlSessionMetadata): Promise<SessionStorage<JsonlSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		return await JsonlSessionStorage.open(this.fs, metadata.path);
	}

	async load(metadata: JsonlSessionMetadata): Promise<SessionSnapshot<JsonlSessionMetadata>> {
		const storage = await this.open(metadata);
		return {
			metadata: await storage.getMetadata(),
			leafId: await storage.getLeafId(),
			entries: await storage.getEntries(),
		};
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`)) {
				continue;
			}
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) {
				try {
					sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
				} catch (error) {
					const cause = toError(error);
					if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause;
				}
			}
		}
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}

	async getEntries(metadata: JsonlSessionMetadata, options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return await (await this.open(metadata)).getEntries(options);
	}

	async createEntryId(metadata: JsonlSessionMetadata): Promise<string> {
		return (await this.open(metadata)).createEntryId();
	}

	async appendEntry(metadata: JsonlSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		await (await this.open(metadata)).appendEntry(entry);
	}

	async setLeafId(metadata: JsonlSessionMetadata, leafId: string | null): Promise<LeafEntry> {
		return await (await this.open(metadata)).setLeafId(leafId);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.remove(metadata.path, { force: true }),
			`Failed to delete session ${metadata.path}`,
		);
	}

	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<JsonlSessionMetadata> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source, options);
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this.createSessionFilePath(options.cwd, id, createdAt),
			{
				cwd: options.cwd,
				sessionId: id,
				parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
				metadata: options.metadata ?? sourceMetadata.metadata,
			},
		);
		for (const entry of forkedEntries) {
			await storage.appendEntry(entry);
		}
		return await storage.getMetadata();
	}

	/**
	 * 列出会话根目录下所有按 CWD 分类的会话目录。
	 * 读取会话根目录并返回所有直接子目录的路径（每个对应一个编码后的 CWD）。
	 * @returns 绝对目录路径数组，每个编码的 CWD 对应一个。
	 */
	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
		if (
			!getFileSystemResultOrThrow(
				await this.fs.exists(sessionsRoot),
				`Failed to check sessions root ${sessionsRoot}`,
			)
		) {
			return [];
		}
		const entries = getFileSystemResultOrThrow(
			await this.fs.listDir(sessionsRoot),
			`Failed to list sessions root ${sessionsRoot}`,
		);
		return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
	}
}

/** 创建 JSONL 会话存储实例的工厂函数。 */
export function createJsonlSessionStore(options: JsonlSessionStoreOptions): JsonlSessionStore {
	return new JsonlSessionStore(options);
}

/** 创建 JSONL 会话仓库实例，包含存储和搜索后端。 */
export function createJsonlSessionRepo(
	options: JsonlSessionStoreOptions,
): SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {
	const store = createJsonlSessionStore(options);
	return new SessionRepo({ store, search: new ScanningSessionSearch(store) });
}
