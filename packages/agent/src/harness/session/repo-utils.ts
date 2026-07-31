import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type FileError,
	type Result,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionMetadata,
	type SessionSearch,
	type SessionSearchHit,
	type SessionStats,
	type SessionStorage,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { Session } from "./session.ts";

/**
 * 生成一个新的唯一 session 标识符。
 * 使用 UUIDv7 生成按时间排序的全局唯一 ID，适合作为 session 元数据主键和文件名。
 * @returns UUIDv7 字符串。
 */
export function createSessionId(): string {
	return uuidv7();
}

/**
 * 创建表示当前时刻的 ISO-8601 时间戳字符串。
 * 在整个 session 系统中用于记录创建时间和条目时间戳。
 * @returns ISO-8601 格式的日期时间字符串。
 */
export function createTimestamp(): string {
	return new Date().toISOString();
}

/**
 * 将 SessionStorage 实例包装为 Session 对象。
 * Session 类在原始存储接口之上提供了更高层的 API（append 辅助方法、context 构建、分支管理）。
 * @param storage - 要包装的 session 存储后端。
 * @returns 由给定存储支持的新 Session 实例。
 */
export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

/** 根据 ID 构建条目查找映射。 */
function entriesById(entries: readonly SessionTreeEntry[]): Map<string, SessionTreeEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

/** 在条目列表中查找给定条目 ID 的最近标签。 */
function getLabel(entries: readonly SessionTreeEntry[], id: string): string | undefined {
	let label: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "label" || entry.targetId !== id) continue;
		label = entry.label?.trim() || undefined;
	}
	return label;
}

/** 返回最近的会话名称（如果有记录）。在会话树中搜索最后一个 session_info 条目。 */
function getSessionName(entries: readonly SessionTreeEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
}

/** 计算会话统计信息（消息数量、缓存/非缓存 token 数、总费用）。 */
function getSessionStats(entries: readonly SessionTreeEntry[]): SessionStats {
	let messageCount = 0;
	let cachedTokens = 0;
	let uncachedTokens = 0;
	let totalTokens = 0;
	let costTotal = 0;
	for (const entry of entries) {
		if (entry.type === "message") messageCount += 1;
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
	return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
}

/** 从叶节点到根或到压缩边界的路径。遇到带有 retainedTail 的压缩条目时停止。 */
function getPathToRootOrCompaction(entries: readonly SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
	if (leafId === null) return [];
	const byId = entriesById(entries);
	const path: SessionTreeEntry[] = [];
	let stopAtEntryId: string | null = null;
	let current = byId.get(leafId);
	if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
	while (current) {
		path.unshift(current);
		if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
		if (current.type === "compaction") {
			if (current.retainedTail) break;
			stopAtEntryId = current.firstKeptEntryId ?? null;
		}
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
		current = parent;
	}
	return path;
}

/** 将 SessionStore 适配为 Session 实例，使用 store 的 load/getEntries/createEntryId/appendEntry/setLeafId 方法。 */
export function toStoreSession<TMetadata extends SessionMetadata>(
	store: Pick<SessionStore<TMetadata>, "load" | "getEntries" | "createEntryId" | "appendEntry" | "setLeafId">,
	metadata: TMetadata,
): Session<TMetadata> {
	const load = () => store.load(metadata);
	const storage: SessionStorage<TMetadata> = {
		async getMetadata() {
			return (await load()).metadata;
		},
		async getLeafId() {
			return (await load()).leafId;
		},
		setLeafId: (leafId) => store.setLeafId(metadata, leafId),
		createEntryId: () => store.createEntryId(metadata),
		appendEntry: (entry) => store.appendEntry(metadata, entry),
		async getEntry(id) {
			return entriesById((await load()).entries).get(id);
		},
		async findEntries(type) {
			return (await load()).entries.filter(
				(entry): entry is Extract<SessionTreeEntry, { type: typeof type }> => entry.type === type,
			);
		},
		async getLabel(id) {
			return getLabel((await load()).entries, id);
		},
		async getSessionName() {
			return getSessionName((await load()).entries);
		},
		async getSessionStats() {
			return getSessionStats((await load()).entries);
		},
		async getPathToRootOrCompaction(leafId) {
			return getPathToRootOrCompaction((await load()).entries, leafId);
		},
		getEntries: (options) => store.getEntries(metadata, options),
	};
	return new Session(storage);
}

/**
 * 通用 SessionRepo 实现，委托给 SessionStore 和可选的 SessionSearch 后端。
 * @typeParam TMetadata - 会话元数据类型。
 * @typeParam TCreateOptions - create 方法的选项类型。
 * @typeParam TListOptions - list 方法的选项类型。
 */
export class SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	private readonly store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	private readonly searchBackend: SessionSearch<TMetadata> | null;

	constructor(options: {
		store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		search?: SessionSearch<TMetadata> | null;
	}) {
		this.store = options.store;
		this.searchBackend = options.search ?? null;
	}

	async create(options: TCreateOptions): Promise<Session<TMetadata>> {
		return toStoreSession(this.store, await this.store.create(options));
	}

	async open(metadata: TMetadata): Promise<Session<TMetadata>> {
		const snapshot = await this.store.load(metadata);
		return toStoreSession(this.store, snapshot.metadata);
	}

	list(options?: TListOptions): Promise<TMetadata[]> {
		return this.store.list(options);
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.store.delete(metadata);
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>> {
		return toStoreSession(this.store, await this.store.fork(source, options));
	}

	async search(options: Parameters<SessionSearch<TMetadata>["search"]>[0]): Promise<SessionSearchHit<TMetadata>[]> {
		return this.searchBackend ? await this.searchBackend.search(options) : [];
	}
}

/** 创建 SessionRepo 实例的工厂函数。 */
export function createSessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
>(options: {
	store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	search?: SessionSearch<TMetadata> | null;
}): SessionRepo<TMetadata, TCreateOptions, TListOptions> {
	return new SessionRepo(options);
}

/** 在会话条目中搜索包含指定文本的匹配项，返回搜索结果列表。 */
export function findSessionEntryMatches<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entries: SessionTreeEntry[],
	text: string,
): SessionSearchHit<TMetadata>[] {
	const normalizedText = text.trim().toLowerCase();
	if (!normalizedText) return [];
	return entries.flatMap((entry) => {
		const payload = JSON.stringify(entry);
		if (!payload.toLowerCase().includes(normalizedText)) return [];
		return [{ metadata, entryId: entry.id, timestamp: entry.timestamp, snippet: payload }];
	});
}

/**
 * 解包文件系统 Result，失败时抛出 SessionError。
 * 成功时返回内部值；失败时将文件系统错误映射为 SessionError。
 * @param result - 文件系统操作结果。
 * @param message - 抛出错误时的描述信息。
 * @returns 成功结果中的解包值。
 * @throws {SessionError} 当结果表示失败时。
 */
export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

/**
 * 确定 fork session 时需要复制的条目。
 * fork 位置行为取决于 position 参数：未指定 entryId 时复制所有条目；
 * `"at"` 分支包含目标条目本身；`"before"`（默认）分支在目标条目之前分割。
 * @param storage - 要 fork 的源 session 存储。
 * @param options - fork 配置。
 * @param options.entryId - 要 fork 到或之前的条目 ID。省略时复制所有条目。
 * @param options.position - fork 位置："before"（默认）或 "at"。
 * @returns 要复制到新 session 的有序条目数组。
 * @throws {SessionError} 当目标条目未找到，或 "before" 位置的目标不是 user 消息时。
 */
export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	if (!options.entryId) return storage.getEntries();
	const target = await storage.getEntry(options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		effectiveLeafId = target.id;
	} else {
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
	}
	return storage.getPathToRootOrCompaction(effectiveLeafId);
}
