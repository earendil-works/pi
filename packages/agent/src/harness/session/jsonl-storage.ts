import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	FileSystem,
	JsonlSessionMetadata,
	LeafEntry,
	SessionEntryCursorOptions,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { getFileSystemResultOrThrow } from "./repo-utils.ts";

type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

/**
 * 使用单个条目的标签数据更新内存中的标签查找映射。
 * 仅作用于类型为 `"label"` 的条目。如果标签文本非空，则将目标条目 ID 映射到该标签；
 * 如果标签为空或 `undefined`，则移除该目标的任何现有映射。
 * @param labelsById - 从目标条目 ID 到其当前标签的可变映射。
 * @param entry - 会话树条目，可能是也可能不是标签条目。
 */
function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId);
	}
}

/**
 * 从会话树条目数组构建完整的标签查找映射。
 * 遍历所有条目并累积每个目标 ID 的最新标签。后出现的标签条目会覆盖先出现的。
 * @param entries - 要扫描标签条目的会话树条目数组。
 * @returns 从条目 ID 到其当前标签字符串的映射。
 */
function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

/**
 * 生成一个保证不与现有 ID 冲突的唯一条目 ID。
 * 最多尝试 100 次生成 UUIDv7 的 8 字符后缀，确保其在提供的查找表中不存在。
 * @param byId - 具有 `has(id)` 方法用于检查 ID 冲突的对象。
 * @returns 新会话条目的唯一字符串 ID。
 */
function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		// The uuidv7 prefix is timestamp-derived and nearly constant between calls,
		// so short ids must come from the random tail.
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

/**
 * 构造一个代码为 `"invalid_session"` 的 {@link SessionError}。
 * 当 JSONL 会话文件的头部或整体结构格式错误或缺少必需字段时使用。
 * @param filePath - 有问题的会话文件路径。
 * @param message - 验证失败的简短描述。
 * @param cause - 触发此失败的可选底层错误。
 * @returns 可抛出的 {@link SessionError}。
 */
function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

/**
 * 构造一个代码为 `"invalid_entry"` 的 {@link SessionError}。
 * 当 JSONL 会话文件中的特定行未通过结构验证时使用。
 * @param filePath - 包含无效条目的会话文件路径。
 * @param lineNumber - 发现无效条目的行号（从 1 开始）。
 * @param message - 验证失败的简短描述。
 * @param cause - 触发此失败的可选底层错误。
 * @returns 可抛出的 {@link SessionError}。
 */
function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}

/**
 * 解析并验证 JSONL 会话文件的第一行作为会话头部。有效的头部必须包含 type、version、id、timestamp、cwd 字段。
 * @param line - JSONL 文件的原始第一行（未修剪）。
 * @param filePath - 正在解析的文件路径（用于错误消息）。
 * @returns 已验证的 {@link SessionHeader} 对象。
 * @throws {SessionError} 如果验证失败，代码为 `"invalid_session"`。
 */
function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	const header = parsed as Partial<SessionHeader>;
	if (header.type !== "session") throw invalidSession(filePath, "first line is not a valid session header");
	if (header.version !== 3) throw invalidSession(filePath, "unsupported session version");
	if (typeof header.id !== "string" || !header.id) throw invalidSession(filePath, "session header is missing id");
	if (typeof header.timestamp !== "string" || !header.timestamp) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof header.cwd !== "string" || !header.cwd) throw invalidSession(filePath, "session header is missing cwd");
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(filePath, "session header metadata must be an object");
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

/**
 * 解析并验证单行（头部之后的行）作为会话树条目。
 * 每个条目行必须是一个 JSON 对象，至少包含 type、id、parentId、timestamp 字段。
 * @param line - 要解析的原始 JSON 行。
 * @param filePath - 文件路径（用于错误消息）。
 * @param lineNumber - 文件内的行号（从 1 开始）。
 * @returns 解析后的条目，强制转换为 {@link SessionTreeEntry}。
 * @throws {SessionError} 如果验证失败，代码为 `"invalid_entry"`。
 */
function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	}
	const entry = parsed as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		timestamp?: unknown;
		targetId?: unknown;
	};
	if (typeof entry.type !== "string") throw invalidEntry(filePath, lineNumber, "is missing entry type");
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(filePath, lineNumber, "is missing entry id");
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid parentId");
	}
	if (typeof entry.timestamp !== "string" || !entry.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid targetId");
	}
	return entry as SessionTreeEntry;
}

/**
 * 确定处理给定条目后的有效叶节点 ID。
 * 对于叶节点条目（`type === "leaf"`），叶节点 ID 是条目的 `targetId`；
 * 对于所有其他条目类型，叶节点 ID 是条目自身的 ID。
 * @param entry - 刚被追加或处理的条目。
 * @returns 新的叶节点 ID，如果树指向根节点则为 `null`。
 */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

/**
 * 将解析后的会话头部及其文件路径转换为 {@link JsonlSessionMetadata}。
 * 提取会话 ID、创建时间戳、工作目录、可选的父会话路径以及 JSONL 文件路径本身。
 * @param header - 从 JSONL 文件解析出的已验证 {@link SessionHeader}。
 * @param path - 会话 JSONL 文件的绝对路径。
 * @returns {@link JsonlSessionMetadata} 对象。
 */
function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
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
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	const line = lines[0];
	if (line?.trim()) return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
	throw invalidSession(filePath, "missing session header");
}

/**
 * 从磁盘加载并解析整个 JSONL 会话文件到其内存表示。
 * 读取完整文件内容，解析头部和所有条目行，跟踪当前叶节点 ID。
 * @param fs - 用于读取文件的文件系统抽象。
 * @param filePath - JSONL 会话文件的绝对路径。
 * @returns 包含解析后的头部、所有条目的有序数组以及当前叶节点 ID 的对象。
 * @throws {SessionError} 如果文件缺失、为空或包含无效行。
 */
async function loadJsonlStorage(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<{
	header: SessionHeader;
	entries: SessionTreeEntry[];
	leafId: string | null;
}> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) {
		throw invalidSession(filePath, "missing session header");
	}

	const header = parseHeaderLine(lines[0]!, filePath);
	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i]!, filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
	return { header, entries, leafId };
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;

	private constructor(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionTreeEntry[],
		leafId: string | null,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.metadata = headerToSessionMetadata(header, this.filePath);
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
	}

	static async open(fs: JsonlSessionStorageFileSystem, filePath: string): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath);
		return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
	}

	static async create(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		options: {
			cwd: string;
			sessionId: string;
			parentSessionPath?: string;
			metadata?: Record<string, unknown>;
		},
	): Promise<JsonlSessionStorage> {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSessionPath,
			metadata: options.metadata,
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSessionStorage(fs, filePath, header, [], null);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<LeafEntry> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session leaf ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.currentLeafId = leafId;
		return entry;
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.currentLeafId = leafIdAfterEntry(entry);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	/** 返回最近的会话名称（如果有记录）。 */
	async getSessionName(): Promise<string | undefined> {
		const entries = await this.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}

	/** 计算会话统计信息（消息数量、缓存/非缓存 token 数、总费用）。 */
	async getSessionStats() {
		let messageCount = 0;
		let cachedTokens = 0;
		let uncachedTokens = 0;
		let totalTokens = 0;
		let costTotal = 0;
		for (const entry of this.entries) {
			if (entry.type === "message") {
				messageCount += 1;
			}
			const usage =
				entry.type === "message"
					? entry.message.role === "assistant"
						? entry.message.usage
						: undefined
					: entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined;
			if (
				!usage ||
				typeof usage.input !== "number" ||
				typeof usage.output !== "number" ||
				typeof usage.cacheRead !== "number" ||
				typeof usage.cacheWrite !== "number" ||
				typeof usage.cost?.total !== "number"
			) {
				continue;
			}
			cachedTokens += usage.cacheRead;
			uncachedTokens += usage.input + usage.cacheWrite;
			totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			costTotal += usage.cost.total;
		}
		return {
			messageCount,
			cachedTokens,
			uncachedTokens,
			totalTokens,
			costTotal,
		};
	}

	/** 从叶节点到根或到压缩边界的路径。遇到带有 retainedTail 的压缩条目时停止。 */
	async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	/** 支持游标分页地返回条目的子集。 */
	async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		const start = options?.afterEntrySeq ?? 0;
		const end = options?.limit === undefined ? undefined : start + options.limit;
		return this.entries.slice(start, end);
	}
}
