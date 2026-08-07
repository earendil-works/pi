import type { SessionMutation } from "../state.ts";
import type { Entry, LaneRecord } from "../types.ts";
import { invalidFile } from "./errors.ts";
import type { JsonlSessionMetadata, JsonlV4Header } from "./types.ts";

const ENTRY_TYPES = new Set<Entry["type"]>([
	"message",
	"model_change",
	"thinking_level_change",
	"active_tools_change",
	"compaction",
	"branch_summary",
	"custom",
]);
const RECORD_TYPES = new Set<LaneRecord["type"]>([
	"operation_started",
	"abort_requested",
	"operation_finished",
	"step_attempt",
	"tool_started",
	"queue_enqueued",
	"queue_cancelled",
	"write_deferred",
	"usage",
]);
const OPERATION_KINDS = new Set(["run", "compaction", "navigation"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string, path: string, lineNumber: number): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidFile(path, lineNumber, "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw invalidFile(path, lineNumber, "is not a JSON object");
	return value;
}

function requireString(value: unknown, path: string, line: number, field: string): string {
	if (typeof value !== "string") throw invalidFile(path, line, `has invalid ${field}`);
	return value;
}

function requireSequence(value: unknown, path: string, line: number): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalidFile(path, line, "has invalid seq");
	return value as number;
}

function requireTimestamp(value: unknown, path: string, line: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidFile(path, line, "has invalid timestamp");
	return value as number;
}

function requireNullableId(value: unknown, path: string, line: number, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw invalidFile(path, line, `has invalid ${field}`);
	}
	return value as string | null;
}

export function parseHeader(line: string, path: string): JsonlV4Header {
	const value = parseObject(line, path, 1);
	if (value.kind !== "header") throw invalidFile(path, 1, "is not a header");
	if (value.version !== 4) throw invalidFile(path, 1, "has unsupported session version");
	const parentSessionId = value.parentSessionId;
	if (parentSessionId !== undefined && typeof parentSessionId !== "string") {
		throw invalidFile(path, 1, "has invalid parentSessionId");
	}
	const legacyParentSessionPath = value.legacyParentSessionPath;
	if (legacyParentSessionPath !== undefined && typeof legacyParentSessionPath !== "string") {
		throw invalidFile(path, 1, "has invalid legacyParentSessionPath");
	}
	if (parentSessionId !== undefined && legacyParentSessionPath !== undefined) {
		throw invalidFile(path, 1, "has both parentSessionId and legacyParentSessionPath");
	}
	const metadataValue = value.metadata;
	if (metadataValue !== undefined && !isObject(metadataValue)) throw invalidFile(path, 1, "has invalid metadata");
	const metadata = metadataValue as JsonlV4Header["metadata"];
	return {
		kind: "header",
		version: 4,
		id: requireString(value.id, path, 1, "id"),
		createdAt: requireTimestamp(value.createdAt, path, 1),
		cwd: requireString(value.cwd, path, 1, "cwd"),
		parentSessionId,
		legacyParentSessionPath,
		metadata,
	};
}

export function encodeHeader(header: JsonlV4Header): string {
	return `${JSON.stringify(header)}\n`;
}

export function metadataFromHeader(header: JsonlV4Header, path: string, modifiedAt: number): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.createdAt,
		cwd: header.cwd,
		path,
		modifiedAt,
		sourceFormat: 4,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: header.legacyParentSessionPath }),
		...(header.metadata === undefined ? {} : { metadata: header.metadata }),
	};
}

function parseEntryMutation(
	value: Record<string, unknown>,
	path: string,
	lineNumber: number,
	seq: number,
): Extract<SessionMutation, { kind: "entry" }> {
	const lane = value.lane === undefined ? undefined : requireString(value.lane, path, lineNumber, "lane");
	const id = requireString(value.id, path, lineNumber, "id");
	const type = requireString(value.type, path, lineNumber, "entry type");
	if (!ENTRY_TYPES.has(type as Entry["type"])) throw invalidFile(path, lineNumber, `has unknown entry type ${type}`);
	const parentId = requireNullableId(value.parentId, path, lineNumber, "parentId");
	const timestamp = requireTimestamp(value.timestamp, path, lineNumber);
	if (type === "custom") requireString(value.customType, path, lineNumber, "customType");
	const { kind: _kind, lane: _lane, ...entryFields } = value;
	const entry = { ...entryFields, id, type, parentId, seq, timestamp } as unknown as Entry;
	return lane === undefined ? { kind: "entry", entry } : { kind: "entry", lane, entry };
}

function parseRecordMutation(
	value: Record<string, unknown>,
	path: string,
	lineNumber: number,
	seq: number,
): Extract<SessionMutation, { kind: "record" }> {
	const id = requireString(value.id, path, lineNumber, "id");
	const lane = requireString(value.lane, path, lineNumber, "lane");
	const type = requireString(value.type, path, lineNumber, "record type");
	if (!RECORD_TYPES.has(type as LaneRecord["type"])) {
		throw invalidFile(path, lineNumber, `has unknown record type ${type}`);
	}
	const timestamp = requireTimestamp(value.timestamp, path, lineNumber);
	if (type === "operation_started") {
		if (!isObject(value.intent)) throw invalidFile(path, lineNumber, "has invalid intent");
		const operationKind = requireString(value.intent.kind, path, lineNumber, "operation kind");
		if (!OPERATION_KINDS.has(operationKind)) {
			throw invalidFile(path, lineNumber, `has unknown operation kind ${operationKind}`);
		}
	}
	if (type === "operation_finished") requireString(value.runId, path, lineNumber, "runId");
	const { kind: _kind, ...recordFields } = value;
	return {
		kind: "record",
		record: { ...recordFields, id, lane, type, seq, timestamp } as unknown as LaneRecord,
	};
}

function parseLaneMutation(
	value: Record<string, unknown>,
	path: string,
	lineNumber: number,
	seq: number,
): Extract<SessionMutation, { kind: "lane" }> {
	return {
		kind: "lane",
		seq,
		lane: requireString(value.lane, path, lineNumber, "lane"),
		leafId: requireNullableId(value.leafId, path, lineNumber, "leafId"),
	};
}

function parseFactMutation(
	value: Record<string, unknown>,
	path: string,
	lineNumber: number,
	seq: number,
): Extract<SessionMutation, { kind: "fact" }> {
	if (value.fact === "name") {
		return { kind: "fact", seq, fact: "name", name: requireString(value.name, path, lineNumber, "name") };
	}
	if (value.fact === "label") {
		if (value.label !== undefined && typeof value.label !== "string") {
			throw invalidFile(path, lineNumber, "has invalid label");
		}
		return {
			kind: "fact",
			seq,
			fact: "label",
			targetId: requireString(value.targetId, path, lineNumber, "targetId"),
			label: value.label,
		};
	}
	throw invalidFile(path, lineNumber, "has unknown fact type");
}

export function parseMutation(line: string, path: string, lineNumber: number): SessionMutation {
	const value = parseObject(line, path, lineNumber);
	const seq = requireSequence(value.seq, path, lineNumber);
	switch (value.kind) {
		case "entry":
			return parseEntryMutation(value, path, lineNumber, seq);
		case "record":
			return parseRecordMutation(value, path, lineNumber, seq);
		case "lane":
			return parseLaneMutation(value, path, lineNumber, seq);
		case "fact":
			return parseFactMutation(value, path, lineNumber, seq);
		default:
			throw invalidFile(path, lineNumber, "has unknown mutation kind");
	}
}

export function encodeMutation(mutation: SessionMutation): string {
	switch (mutation.kind) {
		case "entry":
			return `${JSON.stringify({ kind: "entry", lane: mutation.lane, ...mutation.entry })}\n`;
		case "record":
			return `${JSON.stringify({ kind: "record", ...mutation.record })}\n`;
		case "lane":
			return `${JSON.stringify(mutation)}\n`;
		case "fact":
			return `${JSON.stringify(mutation)}\n`;
	}
}
