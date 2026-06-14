import type { TextContent } from "@earendil-works/pi-ai";
import { resolveToCwd } from "./tools/path-utils.ts";

/** Transient probe attached by tools; stripped before persistence. */
export const TOOL_PROBE_KEY = "probe";

export interface ToolExecutionProbe {
	cwd?: string;
	exit_code?: number | null;
	raw?: {
		lines: number;
		bytes: number;
	};
	file?: {
		path?: string | null;
		arg_path?: string | null;
		total_lines?: number;
		total_bytes?: number;
	};
}

export interface ToolCallInstrumentationV1 {
	v: 1;
	timestamp_start: string;
	timestamp_end: string;
	cwd: string;
	exit_code?: number | null;
	raw: {
		lines: number;
		bytes: number;
	};
	file?: {
		path: string | null;
		arg_path?: string | null;
		total_lines?: number;
		total_bytes?: number;
	};
}

export const CATEGORY_BY_TOOL: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "write",
	bash: "execute",
	grep: "search",
	find: "search",
	ls: "list",
};

const pendingInstrumentationByToolCallId = new Map<string, ToolCallInstrumentationV1>();

export class InstrumentedToolError extends Error {
	readonly probe: ToolExecutionProbe;
	readonly resultContent?: TextContent[];
	readonly resultDetails?: unknown;

	constructor(message: string, probe: ToolExecutionProbe, options?: { content?: TextContent[]; details?: unknown }) {
		super(message);
		this.name = "InstrumentedToolError";
		this.probe = probe;
		this.resultContent = options?.content;
		this.resultDetails = options?.details;
	}
}

export function countTextMetrics(text: string): { lines: number; bytes: number } {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (text.length === 0) {
		return { lines: 0, bytes: 0 };
	}
	const lines = text.split("\n");
	if (text.endsWith("\n")) {
		lines.pop();
	}
	return { lines: lines.length, bytes };
}

export function normalizeToolPath(argPath: string, cwd: string): string {
	return resolveToCwd(argPath, cwd);
}

export function extractProbe(details: unknown): ToolExecutionProbe | undefined {
	if (!details || typeof details !== "object") {
		return undefined;
	}
	const probe = (details as Record<string, unknown>)[TOOL_PROBE_KEY];
	if (!probe || typeof probe !== "object") {
		return undefined;
	}
	return probe as ToolExecutionProbe;
}

export function attachProbeToDetails<TDetails>(
	details: TDetails | undefined,
	probe: ToolExecutionProbe,
): TDetails & { probe: ToolExecutionProbe } {
	if (details && typeof details === "object") {
		return { ...(details as object), probe } as TDetails & { probe: ToolExecutionProbe };
	}
	return { probe } as TDetails & { probe: ToolExecutionProbe };
}

export function buildInstrumentation(
	startMs: number,
	endMs: number,
	probe: ToolExecutionProbe | undefined,
	fallbackCwd: string,
): ToolCallInstrumentationV1 {
	const cwd = probe?.cwd ?? fallbackCwd;
	const instrumentation: ToolCallInstrumentationV1 = {
		v: 1,
		timestamp_start: new Date(startMs).toISOString(),
		timestamp_end: new Date(endMs).toISOString(),
		cwd,
		raw: probe?.raw ?? { lines: 0, bytes: 0 },
	};

	if (probe?.exit_code !== undefined) {
		instrumentation.exit_code = probe.exit_code;
	}

	if (probe?.file) {
		instrumentation.file = {
			path: probe.file.path ?? null,
		};
		if (probe.file.arg_path !== undefined) {
			instrumentation.file.arg_path = probe.file.arg_path;
		}
		if (probe.file.total_lines !== undefined) {
			instrumentation.file.total_lines = probe.file.total_lines;
		}
		if (probe.file.total_bytes !== undefined) {
			instrumentation.file.total_bytes = probe.file.total_bytes;
		}
	}

	return instrumentation;
}

export function attachInstrumentation(
	details: unknown,
	instrumentation: ToolCallInstrumentationV1,
): Record<string, unknown> {
	const base =
		details && typeof details === "object"
			? { ...(details as Record<string, unknown>) }
			: ({} as Record<string, unknown>);
	delete base[TOOL_PROBE_KEY];
	return {
		...base,
		instrumentation,
	};
}

export function finalizeDetailsWithInstrumentation(
	details: unknown,
	startMs: number,
	endMs: number,
	fallbackCwd: string,
): Record<string, unknown> | undefined {
	const probe = extractProbe(details);
	const instrumentation = buildInstrumentation(startMs, endMs, probe, fallbackCwd);
	if (!probe && !details) {
		return { instrumentation };
	}
	return attachInstrumentation(details, instrumentation);
}

export function stashInstrumentationForError(toolCallId: string, instrumentation: ToolCallInstrumentationV1): void {
	pendingInstrumentationByToolCallId.set(toolCallId, instrumentation);
}

export function takeStashedInstrumentation(toolCallId: string): ToolCallInstrumentationV1 | undefined {
	const instrumentation = pendingInstrumentationByToolCallId.get(toolCallId);
	pendingInstrumentationByToolCallId.delete(toolCallId);
	return instrumentation;
}

export function resolveInstrumentedFilePath(
	instrumentation: ToolCallInstrumentationV1 | undefined,
	argPath: string | undefined,
	sessionCwd: string,
): string | null {
	if (instrumentation?.file?.path) {
		return instrumentation.file.path;
	}
	const rawArg = argPath ?? instrumentation?.file?.arg_path;
	if (!rawArg) {
		return null;
	}
	const cwd = instrumentation?.cwd ?? sessionCwd;
	return normalizeToolPath(rawArg, cwd);
}

export function categoryForToolName(toolName: string): string {
	return CATEGORY_BY_TOOL[toolName] ?? "execute";
}
