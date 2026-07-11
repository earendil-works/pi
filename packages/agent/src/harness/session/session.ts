import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import type {
	ActiveToolsChangeEntry,
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionContext,
	SessionInfoEntry,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];

export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
) => readonly AgentMessage[] | undefined;

export interface SessionContextBuildOptions {
	/** Additional entry transforms applied after the default compaction transform. */
	entryTransforms?: readonly ContextEntryTransform[];
	/** Optional custom-entry projectors. Custom entries are omitted from model context by default. */
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

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
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = pathEntries[i]!;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) entries.push(entry);
	}
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		entries.push(pathEntries[i]!);
	}
	return entries;
}

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
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "custom") {
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return [];
}

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

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private storage: SessionStorage<TMetadata>;
	private contextBuildOptions: SessionContextBuildOptions;

	constructor(storage: SessionStorage<TMetadata>, contextBuildOptions: SessionContextBuildOptions = {}) {
		this.storage = storage;
		this.contextBuildOptions = contextBuildOptions;
	}

	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	getStorage(): SessionStorage<TMetadata> {
		return this.storage;
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	getEntries(): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries();
	}

	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const leafId = fromId ?? (await this.storage.getLeafId());
		return this.storage.getPathToRoot(leafId);
	}

	async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	private mergeContextBuildOptions(options: SessionContextBuildOptions): SessionContextBuildOptions {
		return {
			entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])],
			entryProjectors: {
				...(this.contextBuildOptions.entryProjectors ?? {}),
				...(options.entryProjectors ?? {}),
			},
		};
	}

	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	async getSessionName(): Promise<string | undefined> {
		const entries = await this.storage.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}

	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.storage.appendEntry(entry);
		return entry.id;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		} satisfies ThinkingLevelChangeEntry);
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		} satisfies ModelChangeEntry);
	}

	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry({
			type: "active_tools_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			activeToolNames: [...activeToolNames],
		} satisfies ActiveToolsChangeEntry);
	}

	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.storage.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		} satisfies LabelEntry);
	}

	async appendSessionName(name: string): Promise<string> {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry({
			type: "session_info",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		} satisfies SessionInfoEntry);
	}

	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.storage.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		await this.storage.setLeafId(entryId);
		if (!summary) return undefined;
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.storage.createEntryId(),
			parentId: entryId,
			timestamp: new Date().toISOString(),
			fromId: entryId ?? "root",
			summary: summary.summary,
			details: summary.details,
			fromHook: summary.fromHook,
		} satisfies BranchSummaryEntry);
	}
}
