import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type LeafEntry,
	type SessionEntryCursorOptions,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";

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
 * @param byId - 具有 `has(id)` 方法用于冲突检查的对象（通常是现有条目的 `Map`）。
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
 * 确定处理给定条目后的有效叶节点 ID。
 * 对于叶节点条目（`type === "leaf"`），叶节点 ID 是条目的 `targetId`；
 * 对于所有其他条目类型，叶节点 ID 是条目自身的 ID——条目本身成为分支的新顶端。
 * @param entry - 刚被追加或处理的条目。
 * @returns 新的叶节点 ID，如果树指向根节点则为 `null`。
 */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

/**
 * {@link SessionStorage} 的内存实现，无磁盘持久化。
 * 在 JavaScript 数据结构（`Map` 和数组）中维护所有会话条目、标签和当前叶节点位置。
 * 适用于测试或不需要持久化存储的临时 harness 运行。
 * @typeParam TMetadata - 会话元数据类型，默认为 {@link SessionMetadata}。
 */
export class InMemorySessionStorage<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionStorage<TMetadata>
{
	private readonly metadata: TMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private leafId: string | null;

	/**
	 * 构造一个新的内存存储实例，可带有可选的初始状态。
	 * 如果提供了 `entries`，则将其深拷贝到内部数组中。叶节点 ID 通过对每个条目依次应用 leafIdAfterEntry 来派生。
	 * @param options - 可选的初始状态。
	 * @param options.entries - 预填充的会话条目，用于初始化存储。
	 * @param options.metadata - 会话元数据；省略时自动生成。
	 * @throws {SessionError} 如果叶节点条目引用了不存在的目标。
	 */
	constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
		this.entries = options?.entries ? [...options.entries] : [];
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(this.entries);
		this.leafId = null;
		for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		this.metadata = options?.metadata ?? ({ id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata);
	}

	/**
	 * 返回会话元数据（ID、创建时间戳以及任何类型特定的字段）。
	 * @returns 存储的会话元数据。
	 */
	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}

	/**
	 * 返回当前叶节点条目 ID，如果树在根节点则为 `null`。
	 * 验证存储的叶节点 ID 在条目映射中仍然存在。
	 * @returns 当前叶节点 ID，或 `null`。
	 * @throws {SessionError} 如果叶节点 ID 引用了不存在的条目。
	 */
	async getLeafId(): Promise<string | null> {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return this.leafId;
	}

	/**
	 * 将会话叶节点移动到不同的条目。追加一个新的 LeafEntry 以记录位置变化。
	 * @param leafId - 目标条目 ID，或 `null` 指向根节点。
	 * @returns 创建的 LeafEntry。
	 * @throws {SessionError} 如果目标条目不存在。
	 */
	async setLeafId(leafId: string | null): Promise<LeafEntry> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = leafId;
		return entry;
	}

	/**
	 * 为新条目生成无冲突的条目 ID。委托给 generateEntryId，使用当前条目映射进行冲突检测。
	 * @returns 唯一条目 ID。
	 */
	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	/**
	 * 向内存存储追加一个会话树条目。更新条目数组、ID 映射、标签缓存和叶节点位置。
	 * @param entry - 要追加的会话树条目。
	 */
	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.leafId = leafIdAfterEntry(entry);
	}

	/**
	 * 通过 ID 查找单个会话树条目。
	 * @param id - 要检索的条目 ID。
	 * @returns 条目（如果找到），或 `undefined`。
	 */
	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	/**
	 * 查找所有匹配给定类型的条目。按指定的 `type` 字符串过滤内部条目数组。
	 * @param type - 要过滤的条目类型（例如 `"message"`、`"label"`）。
	 * @returns 其 `type` 匹配过滤器的条目数组。
	 */
	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	/**
	 * 检索分配给给定条目的最近标签。标签通过内存标签缓存来跟踪。
	 * @param id - 要查询标签的条目 ID。
	 * @returns 标签字符串，如果不存在标签则为 `undefined`。
	 */
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
