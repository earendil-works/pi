import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveToCwd } from "../src/core/tools/path-utils.ts";
import {
	type ToolCallInstrumentationV1,
	categoryForToolName,
	countTextMetrics,
	resolveInstrumentedFilePath,
} from "../src/core/tool-instrumentation.ts";

export interface SessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: Record<string, unknown>;
	cwd?: string;
}

export interface ToolCallMetricsRow {
	session_id: string;
	entry_id: string;
	tool_call_id: string;
	timestamp_start: string;
	timestamp_end: string;
	tool_name: string;
	tool_parameters: Record<string, unknown>;
	category: string;
	cwd: string;
	file_path: string | null;
	file_path_arg: string | null;
	lines_returned: number;
	lines_sent_to_model: number;
	bytes_returned: number;
	bytes_ingested: number;
	total_file_lines: number | null;
	total_file_bytes: number | null;
	bytes_written: number | null;
	lines_written: number | null;
	exit_code: number | null;
}

function getTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: string; text?: string } => {
			return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
		})
		.map((block) => block.text ?? "")
		.join("\n");
}

function getInstrumentation(details: unknown): ToolCallInstrumentationV1 | undefined {
	if (!details || typeof details !== "object") {
		return undefined;
	}
	const instrumentation = (details as { instrumentation?: ToolCallInstrumentationV1 }).instrumentation;
	if (!instrumentation || instrumentation.v !== 1) {
		return undefined;
	}
	return instrumentation;
}

function getArgPath(argumentsValue: Record<string, unknown>): string | undefined {
	const pathValue = argumentsValue.path;
	return typeof pathValue === "string" ? pathValue : undefined;
}

function getWritePayloadMetrics(argumentsValue: Record<string, unknown>): {
	bytes_written: number | null;
	lines_written: number | null;
} {
	const content = argumentsValue.content;
	if (typeof content !== "string") {
		return { bytes_written: null, lines_written: null };
	}
	const metrics = countTextMetrics(content);
	return { bytes_written: metrics.bytes, lines_written: metrics.lines };
}

export function extractToolCallMetricsFromSession(
	entries: SessionEntry[],
	sessionId = "unknown",
): ToolCallMetricsRow[] {
	const header = entries.find((entry) => entry.type === "session");
	const sessionCwd = typeof header?.cwd === "string" ? header.cwd : process.cwd();
	const rows: ToolCallMetricsRow[] = [];

	const toolResultsByCallId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) {
			continue;
		}
		if (entry.message.role !== "toolResult") {
			continue;
		}
		const toolCallId = entry.message.toolCallId;
		if (typeof toolCallId === "string") {
			toolResultsByCallId.set(toolCallId, entry);
		}
	}

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") {
			continue;
		}
		const content = entry.message.content;
		if (!Array.isArray(content)) {
			continue;
		}

		for (const block of content) {
			if (!block || typeof block !== "object" || (block as { type?: string }).type !== "toolCall") {
				continue;
			}
			const toolCall = block as {
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			};
			if (!toolCall.id || !toolCall.name) {
				continue;
			}

			const toolResultEntry = toolResultsByCallId.get(toolCall.id);
			const toolResult = toolResultEntry?.message;
			const argumentsValue = toolCall.arguments ?? {};
			const instrumentation = getInstrumentation(toolResult?.details);
			const ingestedText = getTextFromContent(toolResult?.content);
			const ingestedMetrics = countTextMetrics(ingestedText);
			const writeMetrics = getWritePayloadMetrics(argumentsValue);
			const argPath = getArgPath(argumentsValue) ?? instrumentation?.file?.arg_path ?? null;
			const resolvedFilePath = resolveInstrumentedFilePath(
				instrumentation,
				argPath ?? undefined,
				instrumentation?.cwd ?? sessionCwd,
			);

			rows.push({
				session_id: sessionId,
				entry_id: toolResultEntry?.id ?? entry.id ?? toolCall.id,
				tool_call_id: toolCall.id,
				timestamp_start: instrumentation?.timestamp_start ?? entry.timestamp ?? "",
				timestamp_end: instrumentation?.timestamp_end ?? toolResultEntry?.timestamp ?? "",
				tool_name: toolCall.name,
				tool_parameters: argumentsValue,
				category: categoryForToolName(toolCall.name),
				cwd: instrumentation?.cwd ?? sessionCwd,
				file_path: resolvedFilePath,
				file_path_arg: argPath,
				lines_returned: instrumentation?.raw.lines ?? ingestedMetrics.lines,
				lines_sent_to_model: ingestedMetrics.lines,
				bytes_returned: instrumentation?.raw.bytes ?? ingestedMetrics.bytes,
				bytes_ingested: ingestedMetrics.bytes,
				total_file_lines: instrumentation?.file?.total_lines ?? null,
				total_file_bytes: instrumentation?.file?.total_bytes ?? null,
				bytes_written:
					toolCall.name === "write" || toolCall.name === "edit" ? writeMetrics.bytes_written : null,
				lines_written:
					toolCall.name === "write" || toolCall.name === "edit" ? writeMetrics.lines_written : null,
				exit_code: instrumentation?.exit_code ?? null,
			});
		}
	}

	return rows;
}

export function parseSessionJsonl(content: string): SessionEntry[] {
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SessionEntry);
}

function main(): void {
	const paths = process.argv.slice(2);
	if (paths.length === 0) {
		console.error("Usage: extract-tool-metrics.ts <session.jsonl> [...]");
		process.exit(1);
	}

	for (const filePath of paths) {
		const content = readFileSync(filePath, "utf-8");
		const entries = parseSessionJsonl(content);
		const header = entries.find((entry) => entry.type === "session");
		const sessionId = header && typeof header.id === "string" ? header.id : filePath;
		const rows = extractToolCallMetricsFromSession(entries, sessionId);
		for (const row of rows) {
			process.stdout.write(`${JSON.stringify(row)}\n`);
		}
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
