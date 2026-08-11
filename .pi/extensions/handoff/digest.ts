/**
 * Mechanical digest: session entries -> handoff note fields.
 *
 * Pure functions, no LLM and no network. This runs in pi's exit path, where a hung
 * handler hangs the process, so everything here is a bounded in-memory walk.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { HANDOFF_SCHEMA, type HandoffNote } from "./notes.ts";

/**
 * Excerpt bounds. Both sides of the last exchange are capped, on lines and on characters:
 * the whole note body is re-injected into the successor's context as a user message, so an
 * uncapped paste (a log, a stack trace, a file) at the end of one session would become a
 * permanent oversized prefix on the next session's first turn.
 */
const ASSISTANT_EXCERPT_LINES = 15;
const USER_EXCERPT_LINES = 15;
const EXCERPT_CHARS = 2000;
/** A frontmatter scalar, so held much tighter than the body excerpts. */
const KICKOFF_CHARS = 200;

interface TextBlock {
	type: "text";
	text: string;
}

interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}

export interface FilesTouched {
	read: string[];
	modified: string[];
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "toolCall" &&
		typeof (block as { name?: unknown }).name === "string"
	);
}

/** Flatten a message's content to plain text, dropping images and thinking blocks. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function hasAssistantMessage(entries: SessionEntry[]): boolean {
	return entries.some((entry) => entry.type === "message" && entry.message.role === "assistant");
}

/**
 * Text of the last user message. `custom_message` entries (including a handoff memo
 * injected by the reader) are deliberately skipped — the successor's own prompt is
 * what the next session should continue from, not the briefing it was handed.
 */
export function lastUserText(entries: SessionEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		return contentToText(message.content);
	}
	return "";
}

export function lastAssistantText(entries: SessionEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		return contentToText(message.content);
	}
	return "";
}

export function firstLines(text: string, count: number): string {
	const lines = text.split("\n");
	if (lines.length <= count) return text.trim();
	return `${lines.slice(0, count).join("\n").trim()}\n...`;
}

export function truncateChars(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

/** An excerpt bounded on both axes: a 15-line paste can still be a megabyte. */
export function excerpt(text: string, lines: number): string {
	return truncateChars(firstLines(text, lines), EXCERPT_CHARS);
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

/** Canonical param is `path`; pi accepts `file_path` as a provider-compat alias. */
function toolCallPath(block: ToolCallBlock): string | undefined {
	const raw = block.arguments?.path ?? block.arguments?.file_path;
	return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Files the session read vs. changed, deduped and in first-touch order. A file that
 * was both read and written is reported as modified only.
 */
export function collectFilesTouched(entries: SessionEntry[]): FilesTouched {
	const read: string[] = [];
	const modified: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isToolCallBlock(block)) continue;
			const path = toolCallPath(block);
			if (!path) continue;
			if (block.name === "read") {
				if (!read.includes(path)) read.push(path);
			} else if (block.name === "write" || block.name === "edit") {
				if (!modified.includes(path)) modified.push(path);
			}
		}
	}

	return { read: read.filter((path) => !modified.includes(path)), modified };
}

export interface DigestInput {
	entries: SessionEntry[];
	sessionId: string;
	sessionFile: string;
	cwd: string;
	model: string | undefined;
	/** ISO 8601. Passed in rather than read from the clock so this stays pure. */
	created: string;
}

function renderFilesSection(files: FilesTouched): string {
	const lines: string[] = [];
	if (files.read.length > 0) lines.push(`- read: ${files.read.join(", ")}`);
	if (files.modified.length > 0) lines.push(`- modified: ${files.modified.join(", ")}`);
	return lines.length > 0 ? lines.join("\n") : "- none recorded";
}

/**
 * Build the shutdown digest note. Returns undefined when the session produced no
 * assistant message — nothing happened, so there is nothing to hand off.
 */
export function buildDigestNote(input: DigestInput): HandoffNote | undefined {
	if (!hasAssistantMessage(input.entries)) return undefined;

	const userText = lastUserText(input.entries);
	const assistantText = lastAssistantText(input.entries);
	const files = collectFilesTouched(input.entries);
	const lastRequest = truncateChars(firstLine(userText), KICKOFF_CHARS);

	const body = [
		"## Context",
		"Mechanical digest written when the previous session exited. No LLM summary was made;",
		"the transcript pointer below has the full history.",
		"",
		"## Next steps",
		lastRequest ? `Pick up from the last request: ${lastRequest}` : "No user request was recorded.",
		"",
		"## Files touched",
		renderFilesSection(files),
		"",
		"## Last exchange",
		`**User:** ${excerpt(userText, USER_EXCERPT_LINES) || "(none)"}`,
		"",
		`**Assistant:** ${excerpt(assistantText, ASSISTANT_EXCERPT_LINES) || "(none)"}`,
	].join("\n");

	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: input.sessionId,
			session_file: input.sessionFile,
			cwd: input.cwd,
			created: input.created,
			source: "digest",
			model: input.model,
			kickoff: lastRequest ? `Continue: ${lastRequest}` : "Continue the previous session's work.",
		},
		body,
	};
}
