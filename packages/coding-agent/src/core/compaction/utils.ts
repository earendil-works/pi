/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Skill Block Detection & Compression
// ============================================================================

/**
 * Check if a message contains a <skill> XML block.
 * These are injected by _expandSkillCommand() in agent-session.ts.
 */
export function isSkillBlock(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") {
		return content.includes("<skill name=");
	}
	if (Array.isArray(content)) {
		return content.some(
			(block) => block.type === "text" && block.text && block.text.includes("<skill name="),
		);
	}
	return false;
}

/**
 * Extract skill names from a <skill> block.
 */
function extractSkillNames(text: string): string[] {
	const names: string[] = [];
	const matches = text.matchAll(/<skill name="([^"]+)"/g);
	for (const match of matches) {
		names.push(match[1]);
	}
	return names;
}

/**
 * Compress a skill block to just its metadata, replacing the full content with a marker.
 * Input:  <skill name="xxx" location="...">...</skill>
 * Output: <skill name="xxx" location="...">[skill content compressed — use /skill:xxx to reload]</skill>
 */
export function compressSkillBlock(message: AgentMessage): {
	compressed: AgentMessage;
	skillNames: string[];
} {
	const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
	const text =
		typeof content === "string"
			? content
			: content.find((b) => b.type === "text")?.text || "";

	const skillNames = extractSkillNames(text);

	// Replace full skill block content with a compressed marker
	const compressedText = text.replace(
		/<skill name="([^"]+)" location="([^"]+)">[\s\S]*?<\/skill>/g,
		'<skill name="$1" location="$2">[skill content compressed — use /skill:$1 to reload]</skill>',
	);

	const compressedContent =
		typeof content === "string"
			? compressedText
			: [{ type: "text" as const, text: compressedText }];

	const compressed: AgentMessage = {
		...message,
		content: compressedContent as AgentMessage["content"],
	};

	return { compressed, skillNames };
}

/**
 * Extract and compress skill blocks from messages, returning the compressed messages
 * and a list of all skill names found.
 */
export function extractAndCompressSkillBlocks(
	messages: AgentMessage[],
): {
	compressedMessages: AgentMessage[];
	skillNames: string[];
} {
	const skillNames = new Set<string>();

	const compressedMessages = messages.map((msg) => {
		if (!isSkillBlock(msg)) return msg;

		const { compressed, skillNames: names } = compressSkillBlock(msg);
		for (const name of names) {
			skillNames.add(name);
		}
		return compressed;
	});

	return {
		compressedMessages,
		skillNames: Array.from(skillNames),
	};
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Skill blocks (<skill name="...">) are serialized in a compact form
 * to save tokens — they appear as [Skill: name] rather than full content.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[], options?: { compressSkillBlocks?: boolean }): string {
	const parts: string[] = [];
	const compressSkill = options?.compressSkillBlocks ?? true;

	for (const msg of messages) {
		if (msg.role === "user") {
			let content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");

			// Compress skill blocks to save tokens
			if (compressSkill && content.includes("<skill name=")) {
				const skillNames = extractSkillNames(content);
				const skillList = skillNames.map((n) => `/skill:${n}`).join(", ");
				content = `[Skills loaded: ${skillList}]`;
			}

			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
