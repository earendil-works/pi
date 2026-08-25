import type {
	AgentMessage,
	Entry as CoreEntry,
	Session as CoreSession,
	SessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SqliteSessionMetadata } from "@earendil-works/pi-session-backend-sqlite-node";
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
	type SessionHeader,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type SessionReference,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
} from "./session-manager.ts";

const CUSTOM_MESSAGE_TYPE = "coding-agent:custom-message";
const COMPACTION_DETAILS_KEY = "__codingAgentCompaction";

export type BackendSessionMetadata = SessionMetadata & {
	cwd?: string;
	path?: string;
};

function isoTimestamp(timestamp: number | string): string {
	return new Date(timestamp).toISOString();
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function compactionDetails(entry: Extract<CoreEntry, { type: "compaction" }>): {
	firstKeptEntryId: string;
	details?: unknown;
	fromHook?: boolean;
} {
	if (entry.details && typeof entry.details === "object" && COMPACTION_DETAILS_KEY in entry.details) {
		const envelope = entry.details as Record<string, unknown>;
		const metadata = envelope[COMPACTION_DETAILS_KEY] as Record<string, unknown>;
		return {
			firstKeptEntryId: typeof metadata.firstKeptEntryId === "string" ? metadata.firstKeptEntryId : entry.id,
			details: envelope.details,
			fromHook: metadata.fromHook === true,
		};
	}
	return { firstKeptEntryId: entry.id, details: entry.details };
}

function toSessionEntry(entry: CoreEntry): SessionEntry | undefined {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: isoTimestamp(entry.timestamp) };
	switch (entry.type) {
		case "message":
			return { ...base, type: "message", message: entry.message };
		case "thinking_level_change":
			return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
		case "model_change":
			return { ...base, type: "model_change", provider: entry.provider, modelId: entry.modelId };
		case "compaction": {
			const metadata = compactionDetails(entry);
			return {
				...base,
				type: "compaction",
				summary: entry.summary,
				firstKeptEntryId: metadata.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
				details: metadata.details,
				usage: entry.usage,
				fromHook: metadata.fromHook,
			};
		}
		case "branch_summary":
			return {
				...base,
				type: "branch_summary",
				fromId: entry.fromId,
				summary: entry.summary,
				details: entry.details,
				usage: entry.usage,
			};
		case "custom":
			if (entry.customType === CUSTOM_MESSAGE_TYPE && entry.data && typeof entry.data === "object") {
				const data = entry.data as Omit<
					CustomMessageEntry,
					keyof typeof base | "type" | "id" | "parentId" | "timestamp"
				>;
				return { ...base, type: "custom_message", ...data };
			}
			return { ...base, type: "custom", customType: entry.customType, data: entry.data };
		case "active_tools_change":
			return undefined;
	}
}

/** Async backend-neutral session facade with a synchronous read snapshot. */
export class BackendSessionManager {
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	private labels = new Map<string, string>();
	private leafId: string | null = null;
	private sessionName: string | undefined;
	private metadata!: BackendSessionMetadata;
	private closePromise: Promise<void> | undefined;
	private readonly session: CoreSession;
	private readonly backend: SessionReference["backend"];
	private readonly release: () => Promise<void>;

	private constructor(session: CoreSession, backend: SessionReference["backend"], release: () => Promise<void>) {
		this.session = session;
		this.backend = backend;
		this.release = release;
	}

	static async hydrate(
		session: CoreSession,
		backend: SessionReference["backend"],
		release: () => Promise<void> = async () => undefined,
	): Promise<BackendSessionManager> {
		const manager = new BackendSessionManager(session, backend, release);
		await manager.refresh();
		return manager;
	}

	private async refresh(): Promise<void> {
		this.metadata = (await this.session.getMetadata()) as BackendSessionMetadata;
		this.leafId = await this.session.getLeafId();
		const coreEntries = await this.session.findEntries({ order: "oldestFirst" });
		this.entries = coreEntries.map(toSessionEntry).filter((entry): entry is SessionEntry => entry !== undefined);
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.sessionName = await this.session.getName();
		this.labels.clear();
		await Promise.all(
			this.entries.map(async (entry) => {
				const label = await this.session.getLabel(entry.id);
				if (label) this.labels.set(entry.id, label);
			}),
		);
	}

	private async mutate<T>(mutation: () => Promise<T>): Promise<T> {
		const result = await mutation();
		await this.refresh();
		return result;
	}

	private nextId(): string {
		return this.session.idGenerator.next();
	}

	getSessionId(): string {
		return this.metadata.id;
	}

	getCwd(): string {
		return this.metadata.cwd ?? process.cwd();
	}

	getSessionReference(): SessionReference {
		return { backend: this.backend, id: this.metadata.id, storagePath: this.metadata.path };
	}

	getSessionFile(): string | undefined {
		return this.backend === "jsonl" ? this.metadata.path : undefined;
	}

	getHeader(): SessionHeader {
		return {
			type: "session",
			version: 3,
			id: this.metadata.id,
			timestamp: isoTimestamp(this.metadata.createdAt),
			cwd: this.getCwd(),
		};
	}

	getSessionDir(): string {
		return this.metadata.path ? this.metadata.path.replace(/[\\/][^\\/]+$/, "") : "";
	}

	isPersisted(): boolean {
		return this.backend !== "memory";
	}

	usesDefaultSessionDir(): boolean {
		return false;
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
		return this.sessionName;
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
		for (const entry of this.entries) nodes.set(entry.id, { entry, children: [], label: this.labels.get(entry.id) });
		for (const entry of this.entries) {
			const node = nodes.get(entry.id)!;
			const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.mutate(() => this.session.appendMessage(jsonClone(message)));
	}

	appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.mutate(() =>
			this.session
				.appendEntry({ id: this.nextId(), type: "thinking_level_change", thinkingLevel }, "main")
				.then((entry) => entry.id),
		);
	}

	appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.mutate(() =>
			this.session
				.appendEntry({ id: this.nextId(), type: "model_change", provider, modelId }, "main")
				.then((entry) => entry.id),
		);
	}

	appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.mutate(() =>
			this.session
				.appendEntry({ id: this.nextId(), type: "active_tools_change", activeToolNames }, "main")
				.then((entry) => entry.id),
		);
	}

	appendCompaction(
		summary: string,
		firstKeptEntryId: string | undefined,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	): Promise<string> {
		return this.mutate(async () => {
			const branch = this.getBranch();
			const firstKeptIndex = firstKeptEntryId ? branch.findIndex((entry) => entry.id === firstKeptEntryId) : -1;
			const retainedTail = (firstKeptIndex < 0 ? [] : branch.slice(firstKeptIndex))
				.filter((entry): entry is SessionMessageEntry => entry.type === "message")
				.map((entry) => entry.message);
			const entry = await this.session.appendEntry(
				{
					id: this.nextId(),
					type: "compaction",
					summary,
					retainedTail,
					tokensBefore,
					details: jsonClone({ [COMPACTION_DETAILS_KEY]: { firstKeptEntryId, fromHook }, details }),
				},
				"main",
			);
			return entry.id;
		});
	}

	appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.mutate(() =>
			this.session.appendCustomEntry(customType, data === undefined ? undefined : jsonClone(data)),
		);
	}

	appendCustomMessageEntry(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
	): Promise<string> {
		return this.mutate(() =>
			this.session.appendCustomEntry(CUSTOM_MESSAGE_TYPE, jsonClone({ customType, content, display, details })),
		);
	}

	appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		return this.mutate(async () => {
			await this.session.setLabel(targetId, label);
			return this.nextId();
		});
	}

	appendSessionInfo(name: string): Promise<string> {
		return this.mutate(async () => {
			await this.session.setName(name);
			return this.nextId();
		});
	}

	branch(entryId: string): Promise<void> {
		return this.mutate(() => this.session.moveLane("main", entryId));
	}

	resetLeaf(): Promise<void> {
		return this.mutate(() => this.session.moveLane("main", null));
	}

	branchWithSummary(
		entryId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
	): Promise<string | undefined> {
		return this.mutate(async () => {
			const fromId = this.leafId;
			await this.session.moveLane("main", entryId);
			if (!fromId) return undefined;
			const entry = await this.session.appendEntry(
				{ id: this.nextId(), type: "branch_summary", fromId, summary, details: jsonClone({ details, fromHook }) },
				"main",
			);
			return entry.id;
		});
	}

	close(): Promise<void> {
		this.closePromise ??= this.release();
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
