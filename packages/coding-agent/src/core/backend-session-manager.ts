import type {
	AgentMessage,
	Session as CoreSession,
	SessionTreeEntry as CoreSessionTreeEntry,
	SessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "@earendil-works/pi-agent-core/sqlite";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type SessionContext,
	type SessionEntry,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type SessionReference,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
} from "./session-manager.ts";

export type BackendSessionMetadata = SessionMetadata & {
	cwd?: string;
	path?: string;
};

/** Async backend-neutral session facade with a synchronous read snapshot. */
export class BackendSessionManager {
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	private labels = new Map<string, string>();
	private leafId: string | null = null;
	private metadata!: BackendSessionMetadata;
	private closePromise: Promise<void> | undefined;
	private readonly session: CoreSession;
	private readonly backend: SessionReference["backend"];

	private constructor(session: CoreSession, backend: SessionReference["backend"]) {
		this.session = session;
		this.backend = backend;
	}

	static async hydrate(session: CoreSession, backend: SessionReference["backend"]): Promise<BackendSessionManager> {
		const manager = new BackendSessionManager(session, backend);
		await manager.refresh();
		return manager;
	}

	private async refresh(): Promise<void> {
		this.metadata = (await this.session.getMetadata()) as BackendSessionMetadata;
		this.leafId = await this.session.getLeafId();
		this.entries = (await this.session.getEntries()).filter(
			(entry): entry is CoreSessionTreeEntry & SessionEntry => entry.type !== "leaf",
		);
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.labels.clear();
		for (const entry of this.entries) {
			if (entry.type !== "label") continue;
			if (entry.label) this.labels.set(entry.targetId, entry.label);
			else this.labels.delete(entry.targetId);
		}
	}

	private async mutate<T>(mutation: () => Promise<T>): Promise<T> {
		const result = await mutation();
		await this.refresh();
		return result;
	}

	getSessionId(): string {
		return this.metadata.id;
	}

	getCwd(): string {
		return this.metadata.cwd ?? process.cwd();
	}

	getSessionReference(): SessionReference {
		return {
			backend: this.backend,
			id: this.metadata.id,
			storagePath: this.metadata.path,
		};
	}

	getSessionFile(): string | undefined {
		return this.backend === "jsonl" ? this.metadata.path : undefined;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getEntries(): SessionEntry[] {
		return [...this.entries];
	}

	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		let entry = this.byId.get(fromId ?? this.leafId ?? "");
		while (entry) {
			path.push(entry);
			entry = entry.parentId ? this.byId.get(entry.parentId) : undefined;
		}
		return path.reverse();
	}

	getLabel(id: string): string | undefined {
		return this.labels.get(id);
	}

	getSessionName(): string | undefined {
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			const entry = this.entries[index];
			if (entry?.type === "session_info") return entry.name?.trim() || undefined;
		}
		return undefined;
	}

	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.entries, this.leafId, this.byId);
	}

	buildSessionContext(): SessionContext {
		return buildSessionContext(this.entries, this.leafId, this.byId);
	}

	getTree(): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];
		for (const entry of this.entries) {
			nodes.set(entry.id, { entry, children: [], label: this.labels.get(entry.id) });
		}
		for (const entry of this.entries) {
			const node = nodes.get(entry.id)!;
			const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.mutate(() => this.session.appendMessage(message));
	}

	appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.mutate(() => this.session.appendThinkingLevelChange(thinkingLevel));
	}

	appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.mutate(() => this.session.appendModelChange(provider, modelId));
	}

	appendCompaction(
		summary: string,
		firstKeptEntryId: string | undefined,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	): Promise<string> {
		return this.mutate(() =>
			this.session.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook),
		);
	}

	appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.mutate(() => this.session.appendCustomEntry(customType, data));
	}

	appendCustomMessageEntry(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
	): Promise<string> {
		return this.mutate(() => this.session.appendCustomMessageEntry(customType, content, display, details));
	}

	appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		return this.mutate(() => this.session.appendLabel(targetId, label));
	}

	appendSessionInfo(name: string): Promise<string> {
		return this.mutate(() => this.session.appendSessionName(name));
	}

	branch(entryId: string): Promise<void> {
		return this.mutate(() => this.session.moveTo(entryId)).then(() => undefined);
	}

	resetLeaf(): Promise<void> {
		return this.mutate(() => this.session.moveTo(null)).then(() => undefined);
	}

	branchWithSummary(
		entryId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
	): Promise<string | undefined> {
		return this.mutate(() => this.session.moveTo(entryId, { summary, details, fromHook }));
	}

	close(): Promise<void> {
		this.closePromise ??= this.session.close();
		return this.closePromise;
	}
}

// Compile-time compatibility checks for the entry variants cached by the facade.
type CachedEntryVariants =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;
void (undefined as unknown as CachedEntryVariants | SqliteSessionMetadata);
