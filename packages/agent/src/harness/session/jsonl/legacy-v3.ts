import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import type { AgentMessage, ThinkingLevel } from "../../../types.ts";
import type { Context } from "../../context.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../../messages.ts";
import type { FileSystem } from "../../types.ts";
import { addUsage, emptyUsage } from "../../utils/usage.ts";
import type { CommittedEntryWrite, CommittedValueSetWrite, CommittedWrite } from "../commit.ts";
import type { JsonValue, LaneConfiguration } from "../types.ts";
import { branchTip, entryLabel, laneConfig, laneState, sessionName } from "../values.ts";
import { type LegacyV3SessionHeader, parseJsonlSessionHeader } from "./codec.ts";
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
	thinkingLevel: string;
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

export interface NormalizedLegacyV3Records {
	writes: CommittedWrite[];
	importedUsage: Usage;
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

function parseLegacyV3Entry(line: string, lineNumber: number): LegacyV3Entry {
	let entry: LegacyV3Entry;
	try {
		entry = JSON.parse(line) as LegacyV3Entry;
	} catch (error) {
		throw new Error(`Invalid legacy v3 JSONL record at line ${lineNumber}: not valid JSON`, { cause: error });
	}
	const recordType: unknown = entry.type;
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
		throw new Error(`Unsupported legacy v3 record type at line ${lineNumber}: ${String(recordType)}`);
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

function isRetainedEntry(entry: LegacyV3Entry): entry is RetainedLegacyV3Entry {
	return (
		entry.type !== "model_change" &&
		entry.type !== "thinking_level_change" &&
		entry.type !== "active_tools_change" &&
		entry.type !== "session_info" &&
		entry.type !== "label"
	);
}

class RetainedIdResolver {
	/** Caches the reminted ID of each discarded legacy node's nearest retained ancestor, or null. */
	private resolvedIds = new Map<string, string | null>();
	private entriesById: Map<string, LegacyV3Entry>;
	private remintedIds: Map<string, string>;

	/**
	 * @param entriesById Complete inventory of legacy physical nodes, including discarded nodes.
	 * @param remintedIds Legacy-to-current ID map containing retained nodes only.
	 */
	constructor(entriesById: Map<string, LegacyV3Entry>, remintedIds: Map<string, string>) {
		this.entriesById = entriesById;
		this.remintedIds = remintedIds;
	}

	/**
	 * Resolve a legacy node to its reminted ID, or to its nearest retained ancestor when discarded.
	 * Returns null when the reference is null or no retained ancestor exists.
	 */
	resolve(legacyId: string | null): string | null {
		const traversedIds: string[] = [];
		const visitedIds = new Set<string>();
		let currentId = legacyId;
		let resolvedId: string | null = null;

		while (currentId !== null) {
			const remintedId = this.remintedIds.get(currentId);
			if (remintedId !== undefined) {
				resolvedId = remintedId;
				break;
			}
			if (this.resolvedIds.has(currentId)) {
				resolvedId = this.resolvedIds.get(currentId) ?? null;
				break;
			}
			if (visitedIds.has(currentId)) throw new Error(`Cycle in legacy v3 parent chain at entry: ${currentId}`);
			visitedIds.add(currentId);
			const entry = this.entriesById.get(currentId);
			if (entry === undefined) throw new Error(`Missing legacy v3 entry reference: ${currentId}`);
			traversedIds.push(currentId);
			currentId = entry.parentId;
		}

		for (const traversedId of traversedIds) this.resolvedIds.set(traversedId, resolvedId);
		return resolvedId;
	}
}

function requireRetainedId(resolver: RetainedIdResolver, legacyId: string): string {
	const importedId = resolver.resolve(legacyId);
	if (importedId === null) throw new Error(`Legacy v3 entry reference has no retained ancestor: ${legacyId}`);
	return importedId;
}

function resolveBranchSummaryFromId(resolver: RetainedIdResolver, legacyFromId: string): string | null {
	// Legacy branchWithSummary() encoded a root source as the "root" sentinel instead of null.
	return legacyFromId === "root" ? null : resolver.resolve(legacyFromId);
}

function projectContextMessages(entry: LegacyV3Entry, resolver: RetainedIdResolver): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return [entry.message];
		case "custom_message":
			return [importedCustomMessage(entry)];
		case "branch_summary":
			return entry.summary
				? [
						createBranchSummaryMessage(
							entry.summary,
							resolveBranchSummaryFromId(resolver, entry.fromId),
							entry.timestamp,
						),
					]
				: [];
		case "compaction":
			return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
		case "custom":
		case "model_change":
		case "thinking_level_change":
		case "active_tools_change":
		case "session_info":
		case "label":
			return [];
	}
}

function materializeRetainedTail(
	compaction: LegacyV3CompactionEntry,
	entriesById: ReadonlyMap<string, LegacyV3Entry>,
	resolver: RetainedIdResolver,
): AgentMessage[] {
	const reversedTail: LegacyV3Entry[] = [];
	const visited = new Set<string>();
	let currentId = compaction.parentId;
	while (currentId !== null) {
		if (visited.has(currentId)) throw new Error(`Cycle in legacy v3 parent chain at entry: ${currentId}`);
		visited.add(currentId);
		const entry = entriesById.get(currentId);
		if (entry === undefined) throw new Error(`Missing legacy v3 parent entry: ${currentId}`);
		reversedTail.push(entry);
		if (currentId === compaction.firstKeptEntryId) {
			return reversedTail.reverse().flatMap((tailEntry) => projectContextMessages(tailEntry, resolver));
		}
		currentId = entry.parentId;
	}
	throw new Error(
		`Legacy v3 compaction ${compaction.id} firstKeptEntryId is not on its parent branch: ${compaction.firstKeptEntryId}`,
	);
}

function normalizeRetainedEntry(
	entry: RetainedLegacyV3Entry,
	seq: number,
	entriesById: ReadonlyMap<string, LegacyV3Entry>,
	resolver: RetainedIdResolver,
): CommittedEntryWrite {
	const committedBase = {
		kind: "entry" as const,
		id: requireRetainedId(resolver, entry.id),
		parentId: resolver.resolve(entry.parentId),
		seq,
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
			fromId: resolveBranchSummaryFromId(resolver, entry.fromId),
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
			retainedTail: materializeRetainedTail(entry, entriesById, resolver),
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

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function selectedConfiguration(
	entriesById: ReadonlyMap<string, LegacyV3Entry>,
	selectedId: string | null,
): LaneConfiguration | undefined {
	let model: LaneConfiguration["model"] | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	let activeToolNames: string[] | undefined;
	let sawModel = false;
	let sawThinkingLevel = false;
	let sawActiveToolNames = false;
	const visited = new Set<string>();
	let currentId = selectedId;
	while (currentId !== null && (!sawModel || !sawThinkingLevel || !sawActiveToolNames)) {
		if (visited.has(currentId)) throw new Error(`Cycle in legacy v3 parent chain at entry: ${currentId}`);
		visited.add(currentId);
		const entry = entriesById.get(currentId);
		if (entry === undefined) throw new Error(`Missing legacy v3 entry reference: ${currentId}`);
		if (entry.type === "model_change" && !sawModel) {
			sawModel = true;
			if (
				typeof entry.provider === "string" &&
				entry.provider.length !== 0 &&
				typeof entry.modelId === "string" &&
				entry.modelId.length !== 0
			) {
				model = { provider: entry.provider, modelId: entry.modelId };
			}
		} else if (entry.type === "thinking_level_change" && !sawThinkingLevel) {
			sawThinkingLevel = true;
			if (typeof entry.thinkingLevel === "string" && THINKING_LEVELS.has(entry.thinkingLevel as ThinkingLevel)) {
				thinkingLevel = entry.thinkingLevel as ThinkingLevel;
			}
		} else if (entry.type === "active_tools_change" && !sawActiveToolNames) {
			sawActiveToolNames = true;
			if (Array.isArray(entry.activeToolNames) && entry.activeToolNames.every((name) => typeof name === "string")) {
				activeToolNames = [...entry.activeToolNames];
			}
		}
		currentId = entry.parentId;
	}
	if (model === undefined || thinkingLevel === undefined) return undefined;
	return { model, thinkingLevel, activeToolNames: activeToolNames ?? [] };
}

function normalizeLegacyV3Values(
	entries: readonly LegacyV3Entry[],
	entriesById: ReadonlyMap<string, LegacyV3Entry>,
	resolver: RetainedIdResolver,
	firstSeq: number,
): CommittedValueSetWrite[] {
	const writes: CommittedValueSetWrite[] = [];
	let latestSessionInfo: LegacyV3SessionInfoEntry | undefined;
	for (const entry of entries) {
		if (entry.type === "session_info") latestSessionInfo = entry;
	}
	if (latestSessionInfo?.name) {
		writes.push({
			kind: "value",
			op: "set",
			seq: firstSeq + writes.length,
			namespace: sessionName.namespace,
			key: sessionName.key,
			value: latestSessionInfo.name,
		});
	}

	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		const targetId = resolver.resolve(entry.targetId);
		// Labels have no current address when their target has no retained ancestor.
		if (targetId === null) continue;
		// Legacy v3 treated both undefined and the empty string as clearing a label.
		if (entry.label) labels.set(targetId, entry.label);
		else labels.delete(targetId);
	}
	for (const [targetId, label] of labels) {
		const address = entryLabel(targetId);
		writes.push({
			kind: "value",
			op: "set",
			seq: firstSeq + writes.length,
			namespace: address.namespace,
			key: address.key,
			value: label,
		});
	}

	const finalEntry = entries.at(-1);
	const tipAddress = branchTip("main");
	writes.push({
		kind: "value",
		op: "set",
		seq: firstSeq + writes.length,
		namespace: tipAddress.namespace,
		key: tipAddress.key,
		value: finalEntry === undefined ? null : resolver.resolve(finalEntry.id),
	});
	const configuration = selectedConfiguration(entriesById, finalEntry?.id ?? null);
	if (configuration !== undefined) {
		const configAddress = laneConfig("main");
		writes.push({
			kind: "value",
			op: "set",
			seq: firstSeq + writes.length,
			namespace: configAddress.namespace,
			key: configAddress.key,
			value: configuration,
		});
		const stateAddress = laneState("main");
		writes.push({
			kind: "value",
			op: "set",
			seq: firstSeq + writes.length,
			namespace: stateAddress.namespace,
			key: stateAddress.key,
			value: { currentOperationId: null, lastOperationId: null, inbox: [] },
		});
	}
	return writes;
}

function aggregateImportedUsage(entries: readonly LegacyV3Entry[]): Usage {
	let aggregate = emptyUsage();
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "message") {
			if (entry.message.role === "assistant") usage = entry.message.usage;
			else if (entry.message.role === "toolResult") usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (usage !== undefined) aggregate = addUsage(aggregate, usage);
	}
	return aggregate;
}

/** Normalize the currently supported v3 records without touching their source file. */
export function normalizeLegacyV3Records(recordLines: readonly string[]): NormalizedLegacyV3Records {
	const entries = recordLines.map((line, index) => parseLegacyV3Entry(line, index + 2));
	const entriesById = new Map<string, LegacyV3Entry>();
	for (const entry of entries) {
		if (entriesById.has(entry.id)) throw new Error(`Duplicate legacy v3 entry id: ${entry.id}`);
		entriesById.set(entry.id, entry);
	}
	const retainedEntries = entries.filter(isRetainedEntry);
	const remintedIds = new Map(retainedEntries.map((entry) => [entry.id, uuidv7(Date.parse(entry.timestamp))]));
	const resolver = new RetainedIdResolver(entriesById, remintedIds);
	const entryWrites = retainedEntries.map((entry, index) =>
		normalizeRetainedEntry(entry, index + 1, entriesById, resolver),
	);
	const valueWrites = normalizeLegacyV3Values(entries, entriesById, resolver, entryWrites.length + 1);
	const writes: CommittedWrite[] = [...entryWrites, ...valueWrites];
	return {
		writes,
		importedUsage: aggregateImportedUsage(entries),
		nextSeq: writes.length + 1,
	};
}
