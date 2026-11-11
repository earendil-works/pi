// Child-owned metadata and JSONL paths; no child transcript is serialized into parent tool details.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { ModelThinkingLevelSchema } from "../pi-ai-schemas.ts";
import type { UsageTotals } from "../usage-totals.ts";
import { AgentDefinitionSchema } from "./definitions.ts";

export const SubagentIdSchema = Type.String({
	pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const StatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
	Type.Literal("interrupted"),
	Type.Literal("paused"),
]);
const RecordSchema = Type.Object({
	id: SubagentIdSchema,
	parentSessionId: Type.String({ minLength: 1 }),
	originEntryId: Type.Union([Type.String(), Type.Null()]),
	runStartId: Type.Union([Type.String(), Type.Null()]),
	cwd: Type.String(),
	role: AgentDefinitionSchema,
	tools: Type.Array(Type.String()),
	model: Type.Object({ provider: Type.String(), id: Type.String() }),
	thinkingLevel: ModelThinkingLevelSchema,
	task: Type.String(),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
	labelError: Type.Optional(Type.String()),
	status: StatusSchema,
	createdAt: Type.Number(),
	updatedAt: Type.Number(),
	run: Type.Integer({ minimum: 1 }),
	async: Type.Boolean(),
	preview: Type.String(),
	error: Type.Optional(Type.String()),
	usage: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cost: Type.Number(),
	}),
});
const validator = Compile(RecordSchema);
export type SubagentRecord = Static<typeof RecordSchema>;
export type SubagentStatus = SubagentRecord["status"];

export interface SubagentInfo {
	id: string;
	role: string;
	label: string;
	labelError?: string;
	status: SubagentStatus;
	model: string;
	thinkingLevel: SubagentRecord["thinkingLevel"];
	tools: readonly string[];
	createdAt: number;
	updatedAt: number;
	run: number;
	async: boolean;
	originEntryId: string | null;
	preview: string;
	error?: string;
	usage: UsageTotals;
	historyPath?: string;
}
export interface SubagentHistoryPage {
	text: string;
	offset: number;
	nextOffset?: number;
	totalCharacters: number;
}
export interface SubagentResult {
	agent: SubagentInfo;
	text: string;
	truncated: boolean;
}
export interface SubagentEvent {
	id: string;
	type: "status" | "message" | "progress" | "deleted";
}

/** Decode persisted agent metadata at the filesystem trust boundary. */
export function readSubagentRecord(directory: string, id: string, parentSessionId: string): SubagentRecord {
	const value: unknown = JSON.parse(readFileSync(join(directory, "record.json"), "utf8"));
	if (!validator.Check(value) || value.id !== id || value.parentSessionId !== parentSessionId)
		throw new Error(`Invalid sub-agent record: ${id}`);
	return value;
}

/** Atomically publish child metadata without exposing a partially written record. */
export function writeSubagentRecord(directory: string, record: SubagentRecord): void {
	const temporary = join(directory, `.record-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		renameSync(temporary, join(directory, "record.json"));
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Return bounded catalog metadata without role prompts or child conversation arrays. */
export function subagentInfo(record: SubagentRecord, historyPath?: string): SubagentInfo {
	return {
		id: record.id,
		role: record.role.name,
		label: record.label ?? normalizeSubagentLabel(record.task) ?? record.role.name,
		labelError: record.labelError,
		status: record.status,
		model: `${record.model.provider}/${record.model.id}`,
		thinkingLevel: record.thinkingLevel,
		tools: record.tools,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		run: record.run,
		async: record.async,
		originEntryId: record.originEntryId,
		preview: record.preview,
		error: record.error,
		usage: record.usage,
		...(historyPath ? { historyPath } : {}),
	};
}

/** Normalize model-authored labels and task-derived placeholders into bounded, terminal-safe single lines. */
export function normalizeSubagentLabel(text: string): string | undefined {
	const firstLine = sanitizeBinaryOutput(stripAnsi(text.slice(0, 512))).split(/\r?\n/, 1)[0];
	let label = firstLine
		.replace(/^[\s#*"'`]+|[\s*"'`]+$/gu, "")
		.replace(/\s+/gu, " ")
		.slice(0, 80);
	if (/[\uD800-\uDBFF]/u.test(label.charAt(label.length - 1))) label = label.slice(0, -1);
	return label || undefined;
}
