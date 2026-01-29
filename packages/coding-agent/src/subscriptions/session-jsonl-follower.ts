import type { AssistantMessage } from "@kennyfrc/mu-ai";

export interface JsonlFollowState {
	offset: number;
	remainder: string;
}

export interface JsonlChunkResult<T> {
	entries: T[];
	nextState: JsonlFollowState;
}

interface SessionMessageEntry {
	type: "message";
	message: unknown;
}

export function createInitialFollowState(): JsonlFollowState {
	return { offset: 0, remainder: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseJsonLine(line: string): unknown | null {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}

export function consumeJsonlChunk(state: JsonlFollowState, chunk: string): JsonlChunkResult<unknown> {
	const combined = state.remainder + chunk;
	const lines = combined.split("\n");
	const remainder = lines.pop() ?? "";
	const entries: unknown[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parsed = parseJsonLine(trimmed);
		if (parsed !== null) {
			entries.push(parsed);
		}
	}

	return {
		entries,
		nextState: {
			offset: state.offset + chunk.length,
			remainder,
		},
	};
}

function isSessionMessageEntry(entry: unknown): entry is SessionMessageEntry {
	if (!isRecord(entry)) return false;
	if (entry.type !== "message") return false;
	return "message" in entry;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!isRecord(message)) return false;
	if (message.role !== "assistant") return false;
	if (!Array.isArray(message.content)) return false;
	if (typeof message.stopReason !== "string") return false;
	if (typeof message.timestamp !== "number") return false;
	if (!isRecord(message.usage)) return false;
	if (typeof message.api !== "string") return false;
	if (typeof message.provider !== "string") return false;
	if (typeof message.model !== "string") return false;
	return true;
}

export function extractTurnCompleteAssistantMessages(entries: unknown[]): AssistantMessage[] {
	const results: AssistantMessage[] = [];
	for (const entry of entries) {
		if (!isSessionMessageEntry(entry)) continue;
		const message = entry.message;
		if (!isAssistantMessage(message)) continue;
		if (message.stopReason === "toolUse") continue;
		results.push(message);
	}
	return results;
}
