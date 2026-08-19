import { err, ok, type Result } from "../../types.ts";
import type { SessionMutation } from "../state.ts";
import type { Entry, LaneRecord } from "../types.ts";
import { JsonlDecodeError } from "./errors.ts";
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

function parseObject(line: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new JsonlDecodeError("syntax", "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw new JsonlDecodeError("schema", "is not a JSON object");
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new JsonlDecodeError("schema", `has invalid ${field}`);
	return value;
}

function requireSequence(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new JsonlDecodeError("schema", "has invalid seq");
	}
	return value as number;
}

function requireTimestamp(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new JsonlDecodeError("schema", "has invalid timestamp");
	}
	return value as number;
}

function requireNullableId(value: unknown, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw new JsonlDecodeError("schema", `has invalid ${field}`);
	}
	return value as string | null;
}

function decodeHeader(line: string): JsonlV4Header {
	const value = parseObject(line);
	if (value.kind !== "header") throw new JsonlDecodeError("schema", "is not a header");
	if (value.version !== 4) throw new JsonlDecodeError("schema", "has unsupported session version");
	const parentSessionId = value.parentSessionId;
	if (parentSessionId !== undefined && typeof parentSessionId !== "string") {
		throw new JsonlDecodeError("schema", "has invalid parentSessionId");
	}
	const legacyParentSessionPath = value.legacyParentSessionPath;
	if (legacyParentSessionPath !== undefined && typeof legacyParentSessionPath !== "string") {
		throw new JsonlDecodeError("schema", "has invalid legacyParentSessionPath");
	}
	if (parentSessionId !== undefined && legacyParentSessionPath !== undefined) {
		throw new JsonlDecodeError("schema", "has both parentSessionId and legacyParentSessionPath");
	}
	const metadataValue = value.metadata;
	if (metadataValue !== undefined && !isObject(metadataValue)) {
		throw new JsonlDecodeError("schema", "has invalid metadata");
	}
	const metadata = metadataValue as JsonlV4Header["metadata"];
	return {
		kind: "header",
		version: 4,
		id: requireString(value.id, "id"),
		createdAt: requireTimestamp(value.createdAt),
		cwd: requireString(value.cwd, "cwd"),
		parentSessionId,
		legacyParentSessionPath,
		metadata,
	};
}

export function parseHeader(line: string): Result<JsonlV4Header, JsonlDecodeError> {
	try {
		return ok<JsonlV4Header, JsonlDecodeError>(decodeHeader(line));
	} catch (error) {
		if (error instanceof JsonlDecodeError) return err<JsonlV4Header, JsonlDecodeError>(error);
		throw error;
	}
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

function parseEntryMutation(value: Record<string, unknown>, seq: number): Extract<SessionMutation, { kind: "entry" }> {
	const lane = value.lane === undefined ? undefined : requireString(value.lane, "lane");
	const id = requireString(value.id, "id");
	const type = requireString(value.type, "entry type");
	if (!ENTRY_TYPES.has(type as Entry["type"])) {
		throw new JsonlDecodeError("schema", `has unknown entry type ${type}`);
	}
	const parentId = requireNullableId(value.parentId, "parentId");
	const timestamp = requireTimestamp(value.timestamp);
	if (type === "custom") requireString(value.customType, "customType");
	const { kind: _kind, lane: _lane, ...entryFields } = value;
	const entry = { ...entryFields, id, type, parentId, seq, timestamp } as unknown as Entry;
	return lane === undefined ? { kind: "entry", entry } : { kind: "entry", lane, entry };
}

function parseRecordMutation(
	value: Record<string, unknown>,
	seq: number,
): Extract<SessionMutation, { kind: "record" }> {
	const id = requireString(value.id, "id");
	const lane = requireString(value.lane, "lane");
	const type = requireString(value.type, "record type");
	if (!RECORD_TYPES.has(type as LaneRecord["type"])) {
		throw new JsonlDecodeError("schema", `has unknown record type ${type}`);
	}
	const timestamp = requireTimestamp(value.timestamp);
	if (type === "operation_started") {
		if (!isObject(value.intent)) throw new JsonlDecodeError("schema", "has invalid intent");
		const operationKind = requireString(value.intent.kind, "operation kind");
		if (!OPERATION_KINDS.has(operationKind)) {
			throw new JsonlDecodeError("schema", `has unknown operation kind ${operationKind}`);
		}
	}
	if (type === "operation_finished") requireString(value.runId, "runId");
	const { kind: _kind, ...recordFields } = value;
	return {
		kind: "record",
		record: { ...recordFields, id, lane, type, seq, timestamp } as unknown as LaneRecord,
	};
}

function parseLaneMutation(value: Record<string, unknown>, seq: number): Extract<SessionMutation, { kind: "lane" }> {
	return {
		kind: "lane",
		seq,
		lane: requireString(value.lane, "lane"),
		leafId: requireNullableId(value.leafId, "leafId"),
	};
}

function parseFactMutation(value: Record<string, unknown>, seq: number): Extract<SessionMutation, { kind: "fact" }> {
	if (value.fact === "name") {
		if (value.name !== undefined && typeof value.name !== "string") {
			throw new JsonlDecodeError("schema", "has invalid name");
		}
		return { kind: "fact", seq, fact: "name", name: value.name };
	}
	if (value.fact === "label") {
		if (value.label !== undefined && typeof value.label !== "string") {
			throw new JsonlDecodeError("schema", "has invalid label");
		}
		return {
			kind: "fact",
			seq,
			fact: "label",
			targetId: requireString(value.targetId, "targetId"),
			label: value.label,
		};
	}
	throw new JsonlDecodeError("schema", "has unknown fact type");
}

function decodeMutation(line: string): SessionMutation {
	const value = parseObject(line);
	const seq = requireSequence(value.seq);
	switch (value.kind) {
		case "entry":
			return parseEntryMutation(value, seq);
		case "record":
			return parseRecordMutation(value, seq);
		case "lane":
			return parseLaneMutation(value, seq);
		case "fact":
			return parseFactMutation(value, seq);
		default:
			throw new JsonlDecodeError("schema", "has unknown mutation kind");
	}
}

export function parseMutation(line: string): Result<SessionMutation, JsonlDecodeError> {
	try {
		return ok<SessionMutation, JsonlDecodeError>(decodeMutation(line));
	} catch (error) {
		if (error instanceof JsonlDecodeError) return err<SessionMutation, JsonlDecodeError>(error);
		throw error;
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
