import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import type {
	ActiveToolsChangeEntry,
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	LeafEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionContext,
	SessionEntryCursorOptions,
	SessionInfoEntry,
	SessionMetadata,
	SessionSnapshot,
	SessionStats,
	SessionStorage,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

/** 对上下文条目列表应用转换，用于过滤或重新排列条目。 */
export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];

/** 将自定义条目投射为上下文消息，未定义时表示该自定义类型不应出现在上下文消息中。 */
export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
) => readonly AgentMessage[] | undefined;

/** 构建会话上下文的选项。 */
export interface SessionContextBuildOptions {
	/** 在默认压缩转换之后应用的额外条目转换。 */
	entryTransforms?: readonly ContextEntryTransform[];
	/** 可选的自定义条目投射器。自定义条目默认不会出现在模型上下文中。 */
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

/** 从路径条目中派生会话上下文状态（思考等级、模型、活跃工具），不包含消息列表。 */
function deriveSessionContextState(pathEntries: readonly SessionTreeEntry[]): Omit<SessionContext, "messages"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}

	return { thinkingLevel, model, activeToolNames };
}

/** 默认的压缩上下文转换：当存在压缩条目时，仅保留压缩条目及其后的存活条目。 */
export function defaultContextEntryTransform(pathEntries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}
	if (!compaction) {
		return [...pathEntries];
	}

	const entries: SessionTreeEntry[] = [compaction];
	const compactionIdx = pathEntries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
	if (compaction.retainedTail) {
		for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
			entries.push(pathEntries[i]!);
		}
		return entries;
	}
	if (compaction.firstKeptEntryId) {
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = pathEntries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) entries.push(entry);
		}
	}
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		entries.push(pathEntries[i]!);
	}
	return entries;
}

/** 应用默认压缩转换和所有自定义转换，构建最终的上下文条目列表。 */
export function buildContextEntries(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionTreeEntry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) {
		entries = [...transform(entries)];
	}
	return entries;
}

/** 将单个会话树条目转换为上下文消息。自定义条目通过 entryProjectors 投射，默认不产生消息。 */
export function sessionEntryToContextMessages(
	entry: SessionTreeEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	if (entry.type === "message") {
		return [entry.message as AgentMessage];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content as string | (TextContent | ImageContent)[],
				entry.display,
				entry.details,
				entry.timestamp,
			),
		];
	}
	if (entry.type === "compaction") {
		return [
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...(entry.retainedTail ?? []),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "custom") {
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return [];
}

/**
 * 从会话树条目（从根到叶）的线性路径重建 {@link SessionContext}。
 *
 * 按顺序遍历路径条目以跟踪可变会话属性的最新状态，然后组装消息列表。
 * 应用默认压缩转换以及所有自定义条目转换和投射器。
 */
export function buildSessionContext(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}

/** Session 类使用的存储依赖抽象，用于解耦 Session 与具体存储实现。 */
interface SessionDependencies<TMetadata extends SessionMetadata = SessionMetadata> {
	load(): Promise<SessionSnapshot<TMetadata>>;
	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionTreeEntry): Promise<void>;
	setLeafId(leafId: string | null): Promise<LeafEntry>;
}

/** 根据 ID 构建条目查找映射。 */
function entriesById(entries: readonly SessionTreeEntry[]): Map<string, SessionTreeEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

/** 从叶节点到根或到压缩边界的路径。压缩条目之后的条目不会包含在路径中。 */
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

/** 在条目列表中查找给定条目 ID 的最近标签。 */
function getLabel(entries: readonly SessionTreeEntry[], id: string): string | undefined {
	let label: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "label" || entry.targetId !== id) continue;
		const trimmed = entry.label?.trim();
		label = trimmed || undefined;
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

/** 将 SessionStorage 适配为 Session 类使用的 SessionDependencies 接口。 */
function storageToDependencies<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
): SessionDependencies<TMetadata> {
	return {
		async load() {
			return {
				metadata: await storage.getMetadata(),
				leafId: await storage.getLeafId(),
				entries: await storage.getEntries(),
			};
		},
		getEntries: (options) => storage.getEntries(options),
		createEntryId: () => storage.createEntryId(),
		appendEntry: (entry) => storage.appendEntry(entry),
		setLeafId: (leafId) => storage.setLeafId(leafId),
	};
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private readonly dependencies: SessionDependencies<TMetadata>;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(storage: SessionStorage<TMetadata>, contextBuildOptions: SessionContextBuildOptions = {}) {
		this.dependencies = storageToDependencies(storage);
		this.contextBuildOptions = contextBuildOptions;
	}

	async getMetadata(): Promise<TMetadata> {
		return (await this.dependencies.load()).metadata;
	}

	async getLeafId(): Promise<string | null> {
		return (await this.dependencies.load()).leafId;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return entriesById((await this.dependencies.load()).entries).get(id);
	}

	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return this.dependencies.getEntries(options);
	}

	/**
	 * 解析分支——从根到给定条目或当前叶节点的有序路径。
	 * 如果提供了 `fromId`，则该条目作为路径终点；否则从存储中获取当前叶节点 ID。
	 * @param fromId - 可选的条目 ID，用作叶节点。默认为当前叶节点。
	 * @returns 从根到叶节点（含）的有序条目数组。
	 */
	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const state = await this.dependencies.load();
		return getPathToRootOrCompaction(state.entries, fromId ?? state.leafId);
	}

	/** 从结束于当前叶节点的分支构建上下文条目列表（可能已压缩）。 */
	async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	/**
	 * 从结束于当前叶节点的分支构建当前 {@link SessionContext}。
	 * 重建当前位置的消息、思考等级、模型信息和活跃工具名称。
	 * @returns 当前叶节点的完整会话上下文。
	 */
	async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	/** 合并实例级别的上下文构建选项与方法调用级别的选项。 */
	private mergeContextBuildOptions(options: SessionContextBuildOptions): SessionContextBuildOptions {
		return {
			entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])],
			entryProjectors: {
				...(this.contextBuildOptions.entryProjectors ?? {}),
				...(options.entryProjectors ?? {}),
			},
		};
	}

	/** 检索分配给给定条目的最近标签。 */
	async getLabel(id: string): Promise<string | undefined> {
		return getLabel((await this.dependencies.load()).entries, id);
	}

	/** 返回当前会话的统计信息（消息数量、token 用量、费用）。 */
	async getSessionStats(): Promise<SessionStats> {
		return getSessionStats((await this.dependencies.load()).entries);
	}

	/**
	 * 返回最近的会话名称（如果有记录）。
	 * 在会话树中搜索最后一个 session_info 条目，并返回其去除空白后的名称。
	 * @returns 会话显示名称，或 `undefined`。
	 */
	async getSessionName(): Promise<string | undefined> {
		return getSessionName((await this.dependencies.load()).entries);
	}

	private async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.dependencies.appendEntry(entry);
	}

	private setLeafId(leafId: string | null): Promise<LeafEntry> {
		return this.dependencies.setLeafId(leafId);
	}

	private async createEntryId(): Promise<string> {
		return this.dependencies.createEntryId();
	}

	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * 在当前叶节点位置向会话追加一条代理消息条目。
	 * @param message - 要存储的 {@link AgentMessage}。
	 * @returns 生成的条目 ID。
	 */
	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	/**
	 * 记录助手思考等级的变化。
	 * @param thinkingLevel - 新的思考等级（例如 `"low"`、`"medium"`、`"high"`、`"off"`）。
	 * @returns 生成的条目 ID。
	 */
	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		} satisfies ThinkingLevelChangeEntry);
	}

	/**
	 * 记录活跃模型提供商和模型 ID 的变化。
	 * @param provider - 模型提供商名称。
	 * @param modelId - 具体模型标识符。
	 * @returns 生成的条目 ID。
	 */
	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		} satisfies ModelChangeEntry);
	}

	/**
	 * 记录当前助手活跃工具名称的集合。
	 * 存储数组的防御性副本以防止外部修改会话数据。
	 * @param activeToolNames - 当前活跃的工具名称数组。
	 * @returns 生成的条目 ID。
	 */
	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry({
			type: "active_tools_change",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			activeToolNames: [...activeToolNames],
		} satisfies ActiveToolsChangeEntry);
	}

	/**
	 * 记录一个压缩事件，该事件总结早期条目以减少上下文长度。
	 * @param summary - 被压缩内容的可读摘要。
	 * @param firstKeptEntryId - 压缩后保留的第一个条目的 ID。
	 * @param tokensBefore - 压缩前的大致令牌数。
	 * @param details - 描述压缩结果的可选额外数据。
	 * @param fromHook - 压缩是否由钩子触发。
	 * @param usage - 生成此摘要的 LLM 调用用量。
	 * @param retainedTail - 压缩后保留的近期消息。
	 * @returns 生成的条目 ID。
	 */
	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | undefined,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
		retainedTail?: AgentMessage[],
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			retainedTail,
			details,
			usage,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	/**
	 * 追加一个通用的自定义条目，带有任意类型标签和可选负载。
	 * 与 appendCustomMessageEntry 不同，此处创建的条目是结构化的而非对话性的。
	 * @param customType - 标识自定义条目类型的字符串标签。
	 * @param data - 与此条目关联的可选负载。
	 * @returns 生成的条目 ID。
	 */
	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	/**
	 * 追加一个自定义消息条目，它渲染为对话消息但携带自定义类型。
	 * @param customType - 标识自定义消息类型的字符串标签。
	 * @param content - 消息内容（纯字符串或内容块数组）。
	 * @param display - 此消息是否应对用户可见。
	 * @param details - 关于此自定义消息的可选额外数据。
	 * @returns 生成的条目 ID。
	 */
	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}

	/**
	 * 为目标条目分配或清除可读标签。目标条目必须已存在。
	 * @param targetId - 要标记的条目 ID。
	 * @param label - 标签文本，或 `undefined` 以移除标签。
	 * @returns 标签条目本身的生成条目 ID。
	 * @throws {SessionError} 如果目标条目不存在。
	 */
	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		} satisfies LabelEntry);
	}

	/**
	 * 通过追加 session_info 条目设置会话显示名称。名称在存储前会去除空白。
	 * @param name - 期望的会话显示名称。
	 * @returns 生成的条目 ID。
	 */
	async appendSessionName(name: string): Promise<string> {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry({
			type: "session_info",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		} satisfies SessionInfoEntry);
	}

	/**
	 * 将会话叶节点移动到不同条目，实现在会话树内的导航。
	 * 叶节点重新定位到 `entryId`（或 `null` 时回到根节点）。如果提供了 summary，
	 * 则在新位置追加一个分支摘要条目来记录分支切换。
	 * @param entryId - 要移动到的目标条目 ID，或 `null` 重置到根节点。
	 * @param summary - 描述移动原因的可选摘要。
	 * @returns 分支摘要条目的生成条目 ID，如果未提供摘要则返回 `undefined`。
	 * @throws {SessionError} 如果目标条目不存在。
	 */
	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; usage?: Usage; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		await this.setLeafId(entryId);
		if (!summary) return undefined;
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.createEntryId(),
			parentId: entryId,
			timestamp: new Date().toISOString(),
			fromId: entryId ?? "root",
			summary: summary.summary,
			details: summary.details,
			usage: summary.usage,
			fromHook: summary.fromHook,
		} satisfies BranchSummaryEntry);
	}
}
