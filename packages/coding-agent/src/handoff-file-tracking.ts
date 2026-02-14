import type { AssistantMessage, Message, ToolCall } from "@kennyfrc/mu-ai";

import { parseApplyPatchInput } from "./tools/apply-patch/parse.js";

export interface HandoffFileTracking {
	readFiles: string[];
	modifiedFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringKey(value: unknown, key: string): string | null {
	if (!isRecord(value)) return null;
	const raw = value[key];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function pushUnique(seen: Set<string>, out: string[], value: string): void {
	if (seen.has(value)) return;
	seen.add(value);
	out.push(value);
}

function extractFromToolCall(toolCall: ToolCall): { reads: string[]; modifies: string[] } {
	const reads: string[] = [];
	const modifies: string[] = [];

	if (toolCall.name === "read") {
		const path = readStringKey(toolCall.arguments as unknown, "path");
		if (path) reads.push(path);
		return { reads, modifies };
	}

	if (toolCall.name === "write" || toolCall.name === "edit") {
		const path = readStringKey(toolCall.arguments as unknown, "path");
		if (path) modifies.push(path);
		return { reads, modifies };
	}

	if (toolCall.name === "apply_patch") {
		const input = readStringKey(toolCall.arguments as unknown, "input");
		if (!input) return { reads, modifies };
		const parsed = parseApplyPatchInput(input);
		for (const op of parsed.ops) {
			const path = op.path.trim();
			if (path) modifies.push(path);
		}
		return { reads, modifies };
	}

	return { reads, modifies };
}

export function extractHandoffFileTracking(messages: Message[]): HandoffFileTracking {
	const readFiles: string[] = [];
	const modifiedFiles: string[] = [];

	const seenRead = new Set<string>();
	const seenModified = new Set<string>();

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;

		const assistantMsg = msg as AssistantMessage;
		for (const block of assistantMsg.content) {
			if (block.type !== "toolCall") continue;
			const { reads, modifies } = extractFromToolCall(block);
			for (const path of reads) pushUnique(seenRead, readFiles, path);
			for (const path of modifies) pushUnique(seenModified, modifiedFiles, path);
		}
	}

	return { readFiles, modifiedFiles };
}
