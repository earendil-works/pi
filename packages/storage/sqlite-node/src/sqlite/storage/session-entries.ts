import type { SessionTreeEntry, SessionTreeEntryBase } from "@earendil-works/pi-agent-core";
import { invalidEntry, isRecord } from "./shared.ts";

export interface SessionEntryRow {
	session_id: string;
	id: string;
	entry_seq: number;
	parent_id: string | null;
	type: SessionTreeEntry["type"];
	timestamp: string;
	payload: string;
}

export type EncodedEntry = {
	payload: string;
};

type EntryPayload<TEntry extends SessionTreeEntry> = Omit<TEntry, keyof SessionTreeEntryBase | "type">;

type MessagePayload = EntryPayload<Extract<SessionTreeEntry, { type: "message" }>>;
type ThinkingLevelChangePayload = EntryPayload<Extract<SessionTreeEntry, { type: "thinking_level_change" }>>;
type ModelChangePayload = EntryPayload<Extract<SessionTreeEntry, { type: "model_change" }>>;
type ActiveToolsChangePayload = EntryPayload<Extract<SessionTreeEntry, { type: "active_tools_change" }>>;
type CompactionPayload = EntryPayload<Extract<SessionTreeEntry, { type: "compaction" }>>;
type BranchSummaryPayload = EntryPayload<Extract<SessionTreeEntry, { type: "branch_summary" }>>;
type CustomPayload = EntryPayload<Extract<SessionTreeEntry, { type: "custom" }>>;
type CustomMessagePayload = EntryPayload<Extract<SessionTreeEntry, { type: "custom_message" }>>;
type LabelPayload = EntryPayload<Extract<SessionTreeEntry, { type: "label" }>>;
type SessionInfoPayload = EntryPayload<Extract<SessionTreeEntry, { type: "session_info" }>>;
type LeafPayload = EntryPayload<Extract<SessionTreeEntry, { type: "leaf" }>>;

function parsePayload(row: SessionEntryRow): unknown {
	try {
		return JSON.parse(row.payload);
	} catch (error) {
		throw invalidEntry(`entry ${row.id} payload is not valid JSON`, error instanceof Error ? error : undefined);
	}
}

function isTextImageContentArray(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				isRecord(item) && typeof item.type === "string" && (item.type !== "text" || typeof item.text === "string"),
		)
	);
}

export function validateSessionTreeEntry(entry: SessionTreeEntry): void {
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry("entry is missing id");
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw invalidEntry(`entry ${entry.id} has invalid parentId`);
	}
	if (typeof entry.timestamp !== "string" || !entry.timestamp) {
		throw invalidEntry(`entry ${entry.id} is missing timestamp`);
	}

	switch (entry.type) {
		case "message":
			if (!isRecord(entry.message) || typeof entry.message.role !== "string") {
				throw invalidEntry(`entry ${entry.id} is missing message payload`);
			}
			break;
		case "thinking_level_change":
			if (typeof entry.thinkingLevel !== "string") throw invalidEntry(`entry ${entry.id} is missing thinkingLevel`);
			break;
		case "model_change":
			if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") {
				throw invalidEntry(`entry ${entry.id} has invalid model_change payload`);
			}
			break;
		case "active_tools_change":
			if (
				!Array.isArray(entry.activeToolNames) ||
				entry.activeToolNames.some((value) => typeof value !== "string")
			) {
				throw invalidEntry(`entry ${entry.id} has invalid active_tools_change payload`);
			}
			break;
		case "compaction":
			if (
				typeof entry.summary !== "string" ||
				typeof entry.firstKeptEntryId !== "string" ||
				typeof entry.tokensBefore !== "number" ||
				(entry.retainedTail !== undefined && !Array.isArray(entry.retainedTail))
			) {
				throw invalidEntry(`entry ${entry.id} has invalid compaction payload`);
			}
			break;
		case "branch_summary":
			if (typeof entry.fromId !== "string" || typeof entry.summary !== "string") {
				throw invalidEntry(`entry ${entry.id} has invalid branch_summary payload`);
			}
			break;
		case "custom":
			if (typeof entry.customType !== "string") throw invalidEntry(`entry ${entry.id} has invalid custom payload`);
			break;
		case "custom_message":
			if (
				typeof entry.customType !== "string" ||
				typeof entry.display !== "boolean" ||
				!(typeof entry.content === "string" || isTextImageContentArray(entry.content))
			) {
				throw invalidEntry(`entry ${entry.id} has invalid custom_message payload`);
			}
			break;
		case "label":
			if (typeof entry.targetId !== "string" || (entry.label !== undefined && typeof entry.label !== "string")) {
				throw invalidEntry(`entry ${entry.id} has invalid label payload`);
			}
			break;
		case "session_info":
			if (entry.name !== undefined && typeof entry.name !== "string") {
				throw invalidEntry(`entry ${entry.id} has invalid session_info payload`);
			}
			break;
		case "leaf":
			if (entry.targetId !== null && typeof entry.targetId !== "string") {
				throw invalidEntry(`entry ${entry.id} has invalid leaf payload`);
			}
			break;
		default: {
			const exhaustive: never = entry;
			throw invalidEntry(`unknown entry type ${(exhaustive as { type?: string }).type ?? "unknown"}`);
		}
	}
}

function entryToPayload<TEntry extends SessionTreeEntry>(entry: TEntry): EntryPayload<TEntry> {
	const { type: _type, id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = entry;
	return payload as EntryPayload<TEntry>;
}

export function encodeEntry(entry: SessionTreeEntry): EncodedEntry {
	validateSessionTreeEntry(entry);
	return { payload: JSON.stringify(entryToPayload(entry)) };
}

export function decodeEntry(row: SessionEntryRow): SessionTreeEntry {
	const payload = parsePayload(row);
	if (!isRecord(payload)) throw invalidEntry(`entry ${row.id} payload is not an object`);
	const base = {
		id: row.id,
		parentId: row.parent_id,
		timestamp: row.timestamp,
	};

	switch (row.type) {
		case "message": {
			if (!("message" in payload)) throw invalidEntry(`entry ${row.id} is missing message payload`);
			const messagePayload = payload as MessagePayload;
			return { ...base, type: "message", ...messagePayload };
		}
		case "thinking_level_change":
			if (typeof payload.thinkingLevel !== "string") throw invalidEntry(`entry ${row.id} is missing thinkingLevel`);
			return { ...base, type: "thinking_level_change", ...(payload as ThinkingLevelChangePayload) };
		case "model_change":
			if (typeof payload.provider !== "string" || typeof payload.modelId !== "string") {
				throw invalidEntry(`entry ${row.id} has invalid model_change payload`);
			}
			return { ...base, type: "model_change", ...(payload as ModelChangePayload) };
		case "active_tools_change":
			if (
				!Array.isArray(payload.activeToolNames) ||
				payload.activeToolNames.some((value) => typeof value !== "string")
			) {
				throw invalidEntry(`entry ${row.id} has invalid active_tools_change payload`);
			}
			return { ...base, type: "active_tools_change", ...(payload as ActiveToolsChangePayload) };
		case "compaction":
			if (
				typeof payload.summary !== "string" ||
				typeof payload.firstKeptEntryId !== "string" ||
				typeof payload.tokensBefore !== "number" ||
				(payload.retainedTail !== undefined && !Array.isArray(payload.retainedTail))
			) {
				throw invalidEntry(`entry ${row.id} has invalid compaction payload`);
			}
			return { ...base, type: "compaction", ...(payload as CompactionPayload) };
		case "branch_summary":
			if (typeof payload.fromId !== "string" || typeof payload.summary !== "string") {
				throw invalidEntry(`entry ${row.id} has invalid branch_summary payload`);
			}
			return { ...base, type: "branch_summary", ...(payload as BranchSummaryPayload) };
		case "custom":
			if (typeof payload.customType !== "string") throw invalidEntry(`entry ${row.id} has invalid custom payload`);
			return { ...base, type: "custom", ...(payload as CustomPayload) };
		case "custom_message":
			if (
				typeof payload.customType !== "string" ||
				typeof payload.display !== "boolean" ||
				!("content" in payload)
			) {
				throw invalidEntry(`entry ${row.id} has invalid custom_message payload`);
			}
			return { ...base, type: "custom_message", ...(payload as CustomMessagePayload) };
		case "label":
			if (typeof payload.targetId !== "string") throw invalidEntry(`entry ${row.id} has invalid label payload`);
			if (payload.label !== undefined && typeof payload.label !== "string") {
				throw invalidEntry(`entry ${row.id} has invalid label payload`);
			}
			return { ...base, type: "label", ...(payload as LabelPayload) };
		case "session_info":
			if (payload.name !== undefined && typeof payload.name !== "string") {
				throw invalidEntry(`entry ${row.id} has invalid session_info payload`);
			}
			return { ...base, type: "session_info", ...(payload as SessionInfoPayload) };
		case "leaf":
			if (payload.targetId !== null && typeof payload.targetId !== "string") {
				throw invalidEntry(`entry ${row.id} has invalid leaf payload`);
			}
			return { ...base, type: "leaf", ...(payload as LeafPayload) };
		default:
			throw invalidEntry(`unknown entry type ${row.type}`);
	}
}
