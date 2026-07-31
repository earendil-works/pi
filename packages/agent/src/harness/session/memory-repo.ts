import {
	type LeafEntry,
	type SessionEntryCursorOptions,
	SessionError,
	type SessionMetadata,
	type SessionSnapshot,
	type SessionStorage,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import { createSessionId, createTimestamp, getEntriesToFork, SessionRepo } from "./repo-utils.ts";
import { ScanningSessionSearch } from "./search-backend.ts";

export type InMemorySessionCreateOptions = { id?: string };

/**
 * {@link SessionStore} 的内存实现，底层使用 {@link Map}。
 * 所有会话仅在存储实例的生命周期内存在——没有磁盘持久化。
 * 适用于测试、短期 harness 运行或任何不需要持久化会话存储的场景。
 */
export class InMemorySessionStore implements SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	private sessions = new Map<string, InMemorySessionStorage<SessionMetadata>>();

	/**
	 * 创建一个新的内存会话，并自动生成元数据。
	 * 可以提供可选的 `id`；否则将生成 UUIDv7。
	 * @param options - 可选的创建参数。
	 * @param options.id - 显式会话 ID，省略时自动生成。
	 * @returns 会话元数据。
	 */
	async create(options: InMemorySessionCreateOptions = {}): Promise<SessionMetadata> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		this.sessions.set(metadata.id, storage);
		return metadata;
	}

	/**
	 * 通过元数据检索之前创建的会话存储。
	 * 在内部映射中按 ID 查找。如果不存在则抛出 `"not_found"` 错误。
	 * @param metadata - 会话元数据（必须包含现有会话的 `id`）。
	 * @returns 现有的 {@link SessionStorage} 实例。
	 * @throws {SessionError} 如果未找到具有给定 ID 的会话。
	 */
	async open(metadata: SessionMetadata): Promise<SessionStorage<SessionMetadata>> {
		const storage = this.sessions.get(metadata.id);
		if (!storage) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return storage;
	}

	/** 加载完整会话快照（元数据、叶节点 ID、所有条目）。 */
	async load(metadata: SessionMetadata): Promise<SessionSnapshot<SessionMetadata>> {
		const storage = await this.open(metadata);
		return {
			metadata: await storage.getMetadata(),
			leafId: await storage.getLeafId(),
			entries: await storage.getEntries(),
		};
	}

	/**
	 * 列出当前内存中所有会话的元数据。
	 * @returns 每个存储会话的 {@link SessionMetadata} 数组。
	 */
	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((storage) => storage.getMetadata()));
	}

	/** 通过元数据获取会话的条目列表（支持游标分页）。 */
	async getEntries(metadata: SessionMetadata, options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return await (await this.open(metadata)).getEntries(options);
	}

	/** 为指定会话生成新的唯一条目 ID。 */
	async createEntryId(metadata: SessionMetadata): Promise<string> {
		return (await this.open(metadata)).createEntryId();
	}

	/** 向指定会话追加一个条目。 */
	async appendEntry(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		await (await this.open(metadata)).appendEntry(entry);
	}

	/** 设置指定会话的叶节点 ID，返回创建的 LeafEntry。 */
	async setLeafId(metadata: SessionMetadata, leafId: string | null): Promise<LeafEntry> {
		return await (await this.open(metadata)).setLeafId(leafId);
	}

	/**
	 * 从内存存储中移除一个会话。如果不存在具有给定 ID 的会话，则为空操作。
	 * @param metadata - 标识要移除的会话的会话元数据。
	 */
	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	/**
	 * 分叉一个现有会话，将条目复制到指定的分叉点。
	 * 打开源会话，计算要分叉的条目，并创建一个新的独立会话。
	 * @param sourceMetadata - 源会话的元数据。
	 * @param options - 分叉配置。
	 * @param options.entryId - 要在此条目处或之前分叉（可选）。
	 * @param options.position - 是在条目 `"at"`（处）分叉还是 `"before"`（之前）分叉（默认为 `"before"`）。
	 * @param options.id - 新会话的显式 ID（省略时自动生成）。
	 * @returns 新会话的元数据。
	 * @throws {SessionError} 如果未找到源会话或分叉目标条目。
	 */
	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<SessionMetadata> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source, options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		this.sessions.set(metadata.id, storage);
		return metadata;
	}
}

/** 创建内存会话存储实例的工厂函数。 */
export function createInMemorySessionStore(): InMemorySessionStore {
	return new InMemorySessionStore();
}

/** 创建内存会话仓库实例，包含存储和搜索后端。 */
export function createInMemorySessionRepo(): SessionRepo<SessionMetadata, InMemorySessionCreateOptions, void> {
	const store = createInMemorySessionStore();
	return new SessionRepo({ store, search: new ScanningSessionSearch(store) });
}
