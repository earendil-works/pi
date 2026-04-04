import { readFileSync } from "node:fs";

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string | null;
	message?: unknown;
	[key: string]: unknown;
}

interface TextBlock {
	type: string;
	text?: string;
}

interface MessagePayload {
	role: "user" | "assistant" | "toolResult";
	content: TextBlock[];
}

export interface MessageEntry extends SessionEntry {
	type: "message";
	message: MessagePayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextBlock(value: unknown): value is TextBlock {
	return (
		isRecord(value) && typeof value.type === "string" && (value.text === undefined || typeof value.text === "string")
	);
}

function isMessagePayload(value: unknown): value is MessagePayload {
	return (
		isRecord(value) &&
		(value.role === "user" || value.role === "assistant" || value.role === "toolResult") &&
		Array.isArray(value.content) &&
		value.content.every((item) => isTextBlock(item))
	);
}

function isSessionEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.id === "string" &&
		(value.parentId === undefined || value.parentId === null || typeof value.parentId === "string")
	);
}

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
	return entry.type === "message" && isMessagePayload(entry.message);
}

function readLines(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function parseEntries(lines: string[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		const parsed: unknown = JSON.parse(line);
		if (isSessionEntry(parsed)) {
			entries.push(parsed);
		}
	}
	return entries;
}

export function getLeafId(sessionFile: string): string | null {
	const entries = parseEntries(readLines(sessionFile));
	return entries.length > 0 ? entries[entries.length - 1].id : null;
}

export function getEntryCount(sessionFile: string): number {
	return readLines(sessionFile).length;
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
	return parseEntries(readLines(sessionFile).slice(afterLine));
}

export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isMessageEntry(entry) || entry.message.role !== "assistant") {
			continue;
		}

		const textBlocks = entry.message.content.filter(
			(block) => block.type === "text" && typeof block.text === "string",
		);
		if (textBlocks.length > 0) {
			return textBlocks.map((block) => block.text ?? "").join("\n");
		}
	}
	return null;
}
