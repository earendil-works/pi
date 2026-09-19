import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import type { AgentMessage, ThinkingLevel } from "../../../types.ts";
import type { Context } from "../../context.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../../messages.ts";
import type { FileSystem, TextLineReader } from "../../types.ts";
import { addUsage, emptyUsage } from "../../utils/usage.ts";
import type { CommittedEntryWrite, CommittedValueSetWrite } from "../commit.ts";
import type { JsonValue, LaneConfiguration } from "../types.ts";
import { branchTip, entryLabel, laneConfig, laneState, sessionName, setValue } from "../values.ts";
import { type LegacyV3SessionHeader, parseJsonlSessionHeader } from "./codec.ts";
import { fileValue, readJsonlHeader } from "./io.ts";
import {
	JSONL_FORMAT_VERSION,
	JSONL_STORAGE_VERSION,
	type JsonlSessionMetadata,
	type JsonlStorageHeader,
} from "./types.ts";

interface LegacyV3EntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

interface LegacyV3MessageEntry extends LegacyV3EntryBase {
	type: "message";
	message: AgentMessage;
}

interface LegacyV3CustomEntry extends LegacyV3EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

interface LegacyV3CustomMessageEntry extends LegacyV3EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

interface LegacyV3BranchSummaryEntry extends LegacyV3EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: JsonValue;
	usage?: Usage;
	fromHook?: boolean;
}

interface LegacyV3CompactionEntry extends LegacyV3EntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: JsonValue;
	usage?: Usage;
	fromHook?: boolean;
}

interface LegacyV3ModelChangeEntry extends LegacyV3EntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

interface LegacyV3ThinkingLevelChangeEntry extends LegacyV3EntryBase {
	type: "thinking_level_change";
	thinkingLevel: ThinkingLevel;
}

interface LegacyV3ActiveToolsChangeEntry extends LegacyV3EntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

interface LegacyV3SessionInfoEntry extends LegacyV3EntryBase {
	type: "session_info";
	name?: string;
}

interface LegacyV3LabelEntry extends LegacyV3EntryBase {
	type: "label";
	targetId: string;
	label?: string;
}

interface ImportedCustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
	timestamp: number;
}

type RetainedLegacyV3Entry =
	| LegacyV3MessageEntry
	| LegacyV3CustomEntry
	| LegacyV3CustomMessageEntry
	| LegacyV3BranchSummaryEntry
	| LegacyV3CompactionEntry;

type DiscardedLegacyV3Entry =
	| LegacyV3ModelChangeEntry
	| LegacyV3ThinkingLevelChangeEntry
	| LegacyV3ActiveToolsChangeEntry
	| LegacyV3SessionInfoEntry
	| LegacyV3LabelEntry;

type LegacyV3Entry = RetainedLegacyV3Entry | DiscardedLegacyV3Entry;

interface LegacyV3IndexBase {
	id: string;
	parentId: string | null;
	/** This node's new ID, or its parent's mapped ID when the node is discarded. */
	mappedId: string | null;
}

type RetainedLegacyV3IndexEntry = LegacyV3IndexBase & { mappedId: string; seq: number } & (
		| { type: "message" | "custom" | "custom_message" }
		| { type: "branch_summary"; fromId: string }
		| { type: "compaction"; firstKeptEntryId: string }
	);

/** Keep structure, labels, and configuration changes, but not conversation payloads. */
type LegacyV3IndexEntry =
	| RetainedLegacyV3IndexEntry
	| (LegacyV3IndexBase &
			(
				| Pick<LegacyV3LabelEntry, "type" | "targetId" | "label">
				| Pick<LegacyV3ModelChangeEntry, "type" | "provider" | "modelId">
				| Pick<LegacyV3ThinkingLevelChangeEntry, "type" | "thinkingLevel">
				| Pick<LegacyV3ActiveToolsChangeEntry, "type" | "activeToolNames">
				| { type: "session_info" }
			));

type LegacyV3CompactionIndexEntry = Extract<RetainedLegacyV3IndexEntry, { type: "compaction" }>;

interface LegacyV3Inventory {
	entries: ReadonlyMap<string, LegacyV3IndexEntry>;
	importedUsage: Usage;
	name: string | undefined;
	finalId: string | null;
	nextSeq: number;
}

type JsonlSessionMetadataBase = Omit<JsonlSessionMetadata, "path" | "modifiedAt">;

async function resolveLegacyV3ParentSessionId(
	fileSystem: FileSystem,
	parentSessionPath: string,
	context: Context,
): Promise<string | undefined> {
	const lines = await fileSystem.readTextLines(parentSessionPath, { maxLines: 1 }, context);
	if (!lines.ok || lines.value[0] === undefined) return undefined;
	const parsed = parseJsonlSessionHeader(lines.value[0]);
	return parsed.ok ? parsed.value.header.id : undefined;
}

export async function metadataFromLegacyV3Header(
	fileSystem: FileSystem,
	header: LegacyV3SessionHeader,
	context: Context,
): Promise<JsonlSessionMetadataBase> {
	const metadata: JsonlSessionMetadataBase = {
		id: header.id,
		createdAt: Date.parse(header.timestamp),
		storageVersion: JSONL_STORAGE_VERSION,
		cwd: header.cwd,
	};
	if (header.parentSession !== undefined) {
		const parentSessionId = await resolveLegacyV3ParentSessionId(fileSystem, header.parentSession, context);
		if (parentSessionId !== undefined) metadata.parentSessionId = parentSessionId;
		else metadata.legacyParentSessionPath = header.parentSession;
	}
	return metadata;
}

export async function normalizeLegacyV3Header(
	fileSystem: FileSystem,
	header: LegacyV3SessionHeader,
	context: Context,
): Promise<JsonlStorageHeader> {
	return {
		v: JSONL_FORMAT_VERSION,
		kind: "header",
		...(await metadataFromLegacyV3Header(fileSystem, header, context)),
	};
}

function parseLegacyV3Entry(line: string): LegacyV3Entry {
	let entry: LegacyV3Entry;
	try {
		entry = JSON.parse(line) as LegacyV3Entry;
	} catch (error) {
		throw new Error("Invalid legacy v3 JSONL record: not valid JSON", { cause: error });
	}
	const recordType: unknown = entry?.type;
	if (
		recordType !== "message" &&
		recordType !== "custom" &&
		recordType !== "custom_message" &&
		recordType !== "branch_summary" &&
		recordType !== "compaction" &&
		recordType !== "model_change" &&
		recordType !== "thinking_level_change" &&
		recordType !== "active_tools_change" &&
		recordType !== "session_info" &&
		recordType !== "label"
	) {
		throw new Error(`Unsupported legacy v3 record type: ${String(recordType)}`);
	}
	return entry;
}

function importedCustomMessage(entry: LegacyV3CustomMessageEntry): AgentMessage {
	const message: ImportedCustomMessage = {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		details: entry.details,
		display: entry.display,
		timestamp: Date.parse(entry.timestamp),
	};
	// The coding-agent CustomAgentMessages declaration merge is not visible in this package.
	return message as unknown as AgentMessage;
}

function isRetainedEntry<T extends LegacyV3Entry | LegacyV3IndexEntry>(
	entry: T,
): entry is Extract<T, { type: RetainedLegacyV3Entry["type"] }> {
	return (
		entry.type !== "model_change" &&
		entry.type !== "thinking_level_change" &&
		entry.type !== "active_tools_change" &&
		entry.type !== "session_info" &&
		entry.type !== "label"
	);
}

/**
 * Resolve a legacy ID to its imported ID. Discarded records resolve to the minted ID of their
 * nearest retained ancestor.
 */
type ResolveLegacyId = (legacyId: string | null) => string | null;

/** Parent mappings are already folded during the scan; later references need only a lookup. */
function createLegacyIdResolver(entries: ReadonlyMap<string, LegacyV3IndexEntry>): ResolveLegacyId {
	return (legacyId) => {
		if (legacyId === null) return null;
		const mappedId = entries.get(legacyId)?.mappedId;
		if (mappedId === undefined) throw new Error(`Missing legacy v3 entry reference: ${legacyId}`);
		return mappedId;
	};
}

function resolveBranchSummaryFromId(resolveLegacyId: ResolveLegacyId, legacyFromId: string): string | null {
	// Legacy branchWithSummary() encoded a root source as the "root" sentinel instead of null.
	return legacyFromId === "root" ? null : resolveLegacyId(legacyFromId);
}

function projectContextMessage(entry: LegacyV3Entry, resolveLegacyId: ResolveLegacyId): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			return entry.message;
		case "custom_message":
			return importedCustomMessage(entry);
		case "branch_summary":
			return entry.summary
				? createBranchSummaryMessage(
						entry.summary,
						resolveBranchSummaryFromId(resolveLegacyId, entry.fromId),
						entry.timestamp,
					)
				: undefined;
		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		case "custom":
		case "model_change":
		case "thinking_level_change":
		case "active_tools_change":
		case "session_info":
		case "label":
			return undefined;
	}
}

/** Walk physical ancestry, including discarded nodes and the exact kept boundary. */
function* retainedTailStructure(
	compaction: LegacyV3CompactionIndexEntry,
	entriesById: ReadonlyMap<string, LegacyV3IndexEntry>,
): Iterable<LegacyV3IndexEntry> {
	let currentId = compaction.parentId;
	while (currentId !== null) {
		// The scan guarantees that every parent exists earlier in the file, so cycles are impossible.
		const entry = entriesById.get(currentId)!;
		yield entry;
		if (currentId === compaction.firstKeptEntryId) return;
		currentId = entry.parentId;
	}
	throw new Error(
		`Legacy v3 compaction ${compaction.id} firstKeptEntryId is not on its parent branch: ${compaction.firstKeptEntryId}`,
	);
}

function normalizeRetainedEntry(
	entry: RetainedLegacyV3Entry,
	indexed: RetainedLegacyV3IndexEntry,
	retainedTail: AgentMessage[],
	resolveLegacyId: ResolveLegacyId,
): CommittedEntryWrite {
	const committedBase = {
		kind: "entry" as const,
		id: indexed.mappedId,
		parentId: resolveLegacyId(indexed.parentId),
		seq: indexed.seq,
		timestamp: Date.parse(entry.timestamp),
	};
	if (entry.type === "message") {
		return { ...committedBase, type: "message", message: entry.message };
	}
	if (entry.type === "custom_message") {
		return {
			...committedBase,
			type: "message",
			message: importedCustomMessage(entry),
		};
	}
	if (entry.type === "branch_summary") {
		return {
			...committedBase,
			type: "branch_summary",
			fromId: resolveBranchSummaryFromId(resolveLegacyId, entry.fromId),
			summary: entry.summary,
			details: entry.details,
			usage: entry.usage,
			fromHook: entry.fromHook ?? false,
		};
	}
	if (entry.type === "compaction") {
		return {
			...committedBase,
			type: "compaction",
			summary: entry.summary,
			retainedTail,
			tokensBefore: entry.tokensBefore,
			details: entry.details,
			usage: entry.usage,
			fromHook: entry.fromHook ?? false,
		};
	}
	return {
		...committedBase,
		type: "custom",
		customType: entry.customType,
		data: entry.data,
	};
}

function selectedConfiguration(
	entriesById: ReadonlyMap<string, LegacyV3IndexEntry>,
	selectedId: string | null,
): LaneConfiguration | undefined {
	const remaining = new Set<LegacyV3IndexEntry["type"]>([
		"model_change",
		"thinking_level_change",
		"active_tools_change",
	]);
	let model: LaneConfiguration["model"] | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	let activeToolNames: string[] | undefined;
	let currentId = selectedId;
	while (currentId !== null && remaining.size !== 0) {
		const entry = entriesById.get(currentId)!;
		// Consume the nearest change even when invalid: older values must not become fallbacks.
		if (remaining.delete(entry.type)) {
			switch (entry.type) {
				case "model_change":
					model = { provider: entry.provider, modelId: entry.modelId };
					break;
				case "thinking_level_change":
					thinkingLevel = entry.thinkingLevel;
					break;
				case "active_tools_change":
					activeToolNames = [...entry.activeToolNames];
					break;
			}
		}
		currentId = entry.parentId;
	}
	if (model === undefined || thinkingLevel === undefined) return undefined;
	return { model, thinkingLevel, activeToolNames: activeToolNames ?? [] };
}

function indexLegacyV3Entry(
	entry: LegacyV3Entry,
	lineNumber: number,
	seq: number,
	entries: ReadonlyMap<string, LegacyV3IndexEntry>,
): LegacyV3IndexEntry {
	// SessionManager appends after an existing leaf and writes extracted branches in parent order.
	const mappedParentId = entry.parentId === null ? null : entries.get(entry.parentId)?.mappedId;
	if (mappedParentId === undefined) {
		throw new Error(
			`Legacy v3 entry ${entry.id} has a missing or forward parent at line ${lineNumber}: ${entry.parentId}`,
		);
	}
	const structure: LegacyV3IndexBase = {
		id: entry.id,
		parentId: entry.parentId,
		mappedId: mappedParentId,
	};
	if (!isRetainedEntry(entry)) {
		switch (entry.type) {
			case "label":
				return { ...structure, type: entry.type, targetId: entry.targetId, label: entry.label };
			case "model_change":
				return { ...structure, type: entry.type, provider: entry.provider, modelId: entry.modelId };
			case "thinking_level_change":
				return { ...structure, type: entry.type, thinkingLevel: entry.thinkingLevel };
			case "active_tools_change":
				return { ...structure, type: entry.type, activeToolNames: entry.activeToolNames };
			case "session_info":
				return { ...structure, type: entry.type };
		}
	}
	// Null denotes the root, not a retained node identity that can be reminted.
	if (entry.id === null) throw new Error("Legacy v3 entry reference has no retained ancestor: null");
	const retained = {
		...structure,
		mappedId: uuidv7(Date.parse(entry.timestamp)),
		seq,
	};
	switch (entry.type) {
		case "branch_summary":
			return { ...retained, type: entry.type, fromId: entry.fromId };
		case "compaction":
			return { ...retained, type: entry.type, firstKeptEntryId: entry.firstKeptEntryId };
		default:
			return { ...retained, type: entry.type };
	}
}

function legacyEntryUsage(entry: LegacyV3Entry): Usage | undefined {
	switch (entry.type) {
		case "message":
			return entry.message.role === "assistant" || entry.message.role === "toolResult"
				? entry.message.usage
				: undefined;
		case "compaction":
		case "branch_summary":
			return entry.usage;
		default:
			return undefined;
	}
}

async function readLegacyV3Inventory(reader: TextLineReader, context: Context): Promise<LegacyV3Inventory> {
	const entries = new Map<string, LegacyV3IndexEntry>();
	let nextSeq = 1;
	let importedUsage = emptyUsage();
	let name: string | undefined;
	let finalId: string | null = null;
	while (true) {
		const line = fileValue(await reader.readLine(context), "Failed to read legacy v3 source");
		if (line === undefined || !line.terminated) break;
		const lineNumber = entries.size + 2;
		const entry = parseLegacyV3Entry(line.text);
		if (entries.has(entry.id)) throw new Error(`Duplicate legacy v3 entry id: ${entry.id}`);
		const indexed = indexLegacyV3Entry(entry, lineNumber, nextSeq, entries);
		entries.set(entry.id, indexed);
		if (isRetainedEntry(indexed)) nextSeq++;
		finalId = entry.id;
		if (entry.type === "session_info") name = entry.name;
		const usage = legacyEntryUsage(entry);
		if (usage !== undefined) importedUsage = addUsage(importedUsage, usage);
	}
	return { entries, nextSeq, importedUsage, name, finalId };
}

function normalizeLegacyV3Values(inventory: LegacyV3Inventory): CommittedValueSetWrite[] {
	const { entries, name, finalId } = inventory;
	const resolveLegacyId = createLegacyIdResolver(entries);
	let nextSeq = inventory.nextSeq;
	const values: CommittedValueSetWrite[] = [];

	// session name
	if (name) values.push({ ...setValue(sessionName, name), seq: nextSeq++ });

	// labels
	const labels = new Map<string, string>();
	for (const entry of entries.values()) {
		if (entry.type !== "label") continue;
		const targetId = resolveLegacyId(entry.targetId);
		if (targetId === null) continue;
		if (entry.label) labels.set(targetId, entry.label);
		else labels.delete(targetId);
	}
	for (const [targetId, label] of labels) {
		values.push({ ...setValue(entryLabel(targetId), label), seq: nextSeq++ });
	}

	// branch tip
	values.push({ ...setValue(branchTip("main"), resolveLegacyId(finalId)), seq: nextSeq++ });

	// configuration
	const configuration = selectedConfiguration(entries, finalId);
	if (configuration !== undefined) {
		values.push({ ...setValue(laneConfig("main"), configuration), seq: nextSeq++ });
		values.push({
			...setValue(laneState("main"), { currentOperationId: null, lastOperationId: null, inbox: [] }),
			seq: nextSeq++,
		});
	}
	return values;
}

/**
 * A captured legacy file exposed as repeatable logical v4 writes.
 * Each pass reopens the path; callers must not replace or edit the source between passes.
 * Structural indexes, label/configuration metadata, and derived current values survive between scans.
 */
export class LegacyV3Source {
	readonly header: JsonlStorageHeader;
	readonly importedUsage: Usage;
	readonly nextSeq: number;
	readonly values: readonly CommittedValueSetWrite[];
	private readonly fileSystem: FileSystem;
	private readonly path: string;
	private readonly entries: ReadonlyMap<string, LegacyV3IndexEntry>;
	private readonly resolveLegacyId: ResolveLegacyId;

	private constructor(
		fileSystem: FileSystem,
		path: string,
		header: JsonlStorageHeader,
		entries: ReadonlyMap<string, LegacyV3IndexEntry>,
		importedUsage: Usage,
		values: readonly CommittedValueSetWrite[],
		nextSeq: number,
	) {
		this.fileSystem = fileSystem;
		this.path = path;
		this.header = header;
		this.entries = entries;
		this.resolveLegacyId = createLegacyIdResolver(entries);
		this.importedUsage = importedUsage;
		this.values = values;
		this.nextSeq = nextSeq;
	}

	/**
	 * Scan complete v3 records without modifying the file, ignoring an unterminated final line.
	 * Build parent mappings, assign IDs stable for this source instance, and derive current values
	 * and imported usage. Retain metadata, not conversation payloads or an open reader. writes()
	 * reopens the path to materialize captured records and resolve their payload-specific references.
	 */
	static async read(fileSystem: FileSystem, path: string, context: Context): Promise<LegacyV3Source> {
		const reader = fileValue(
			await fileSystem.openTextLineReader(path, context),
			`Failed to open legacy v3 source ${path}`,
		);
		try {
			const parsed = await readJsonlHeader(reader, path, context);
			if (parsed.format !== "v3-legacy") {
				throw new Error(`Invalid legacy v3 JSONL storage ${path}: expected format 3 header`);
			}
			const inventory = await readLegacyV3Inventory(reader, context);
			const values = normalizeLegacyV3Values(inventory);
			return new LegacyV3Source(
				fileSystem,
				path,
				await normalizeLegacyV3Header(fileSystem, parsed.header, context),
				inventory.entries,
				inventory.importedUsage,
				values,
				inventory.nextSeq + values.length,
			);
		} finally {
			await reader.close(context);
		}
	}

	*entryStructures(): Iterable<Pick<CommittedEntryWrite, "id" | "parentId" | "seq">> {
		for (const entry of this.entries.values()) {
			if (!isRetainedEntry(entry)) continue;
			yield { id: entry.mappedId, parentId: this.resolveLegacyId(entry.parentId), seq: entry.seq };
		}
	}

	translateForkEntryId(legacyId: string): string {
		const entry = this.entries.get(legacyId);
		if (entry === undefined) throw new Error(`Legacy v3 fork entry does not exist: ${legacyId}`);
		if (!isRetainedEntry(entry)) throw new Error(`Legacy v3 fork entry is not a retained entry: ${legacyId}`);
		return entry.mappedId;
	}

	private collectRequiredTailMessageIds(isEntrySelected?: (id: string) => boolean): Set<string> {
		const requiredIds = new Set<string>();
		for (const entry of this.entries.values()) {
			if (entry.type !== "compaction") continue;
			const compactionIsSelected = isEntrySelected === undefined || isEntrySelected(entry.mappedId);
			if (!compactionIsSelected) continue;

			// Walk from the compaction's parent through firstKeptEntryId, inclusive.
			for (const tailEntry of retainedTailStructure(entry, this.entries)) {
				const canProduceContextMessage = isRetainedEntry(tailEntry) && tailEntry.type !== "custom";
				if (canProduceContextMessage) requiredIds.add(tailEntry.id);
			}
		}
		return requiredIds;
	}

	/**
	 * Stream normalized v4 entries, optionally filtered by reminted ID, followed by derived current values.
	 * Each pass owns its reader and message cache, sharing only the captured IDs and metadata.
	 */
	async *writes(
		context: Context,
		isEntrySelected?: (id: string) => boolean,
	): AsyncIterable<CommittedEntryWrite | CommittedValueSetWrite> {
		const requiredTailMessageIds = this.collectRequiredTailMessageIds(isEntrySelected);
		// Keep needed context messages for this entire pass; tails may revisit old or shared branches.
		const tailMessagesByLegacyId = new Map<string, AgentMessage>();
		for await (const { entry, indexed } of this.readCapturedEntries(context)) {
			if (requiredTailMessageIds.has(entry.id)) {
				const message = projectContextMessage(entry, this.resolveLegacyId);
				if (message !== undefined) tailMessagesByLegacyId.set(entry.id, message);
			}
			if (!isRetainedEntry(indexed) || !isRetainedEntry(entry)) continue;
			if (isEntrySelected !== undefined && !isEntrySelected(indexed.mappedId)) continue;
			const retainedTail: AgentMessage[] = [];
			if (indexed.type === "compaction") {
				for (const ancestor of retainedTailStructure(indexed, this.entries)) {
					const message = tailMessagesByLegacyId.get(ancestor.id);
					if (message !== undefined) retainedTail.push(message);
				}
				retainedTail.reverse();
			}
			yield normalizeRetainedEntry(entry, indexed, retainedTail, this.resolveLegacyId);
		}
		yield* this.values;
	}

	/** Replay only the captured prefix and verify its physical identities before materialization. */
	private async *readCapturedEntries(
		context: Context,
	): AsyncIterable<{ entry: LegacyV3Entry; indexed: LegacyV3IndexEntry }> {
		const reader = fileValue(
			await this.fileSystem.openTextLineReader(this.path, context),
			`Failed to reopen legacy v3 source ${this.path}`,
		);
		try {
			const parsed = await readJsonlHeader(reader, this.path, context);
			if (
				parsed.format !== "v3-legacy" ||
				parsed.header.id !== this.header.id ||
				parsed.header.cwd !== this.header.cwd
			) {
				throw new Error("Legacy v3 source header changed");
			}
			for (const indexed of this.entries.values()) {
				const line = fileValue(await reader.readLine(context), "Failed to reread legacy v3 source");
				if (line === undefined || !line.terminated)
					throw new Error("Legacy v3 source ended before captured entries");
				const entry = parseLegacyV3Entry(line.text);
				if (entry.id !== indexed.id || entry.type !== indexed.type) {
					throw new Error("Legacy v3 source changed");
				}
				yield { entry, indexed };
			}
		} finally {
			await reader.close(context);
		}
	}
}
