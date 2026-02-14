import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@kennyfrc/mu-ai";

export type IndexedMessage = { index: number; message: Message };

const DEFAULT_MAX_TEXT_CHARS_PER_MESSAGE = 4000;
const DEFAULT_MAX_TOOL_ARGS_CHARS = 1200;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 1200;

function truncateText(raw: string, maxChars: number): string {
	if (raw.length <= maxChars) return raw;
	return `${raw.slice(0, maxChars)}...[truncated ${raw.length - maxChars} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyArgsCompact(args: unknown): string {
	if (!isRecord(args)) return "{}";

	const allowKeys = [
		"path",
		"offset",
		"limit",
		"pattern",
		"glob",
		"command",
		"input",
		"files",
		"goal",
		"workspace",
		"search",
		"id",
	] as const;

	const picked: Record<string, unknown> = {};

	for (const key of allowKeys) {
		if (!(key in args)) continue;
		const rawValue = args[key];
		if (typeof rawValue === "string") {
			picked[key] = truncateText(rawValue, key === "input" ? 400 : 600);
			continue;
		}
		if (typeof rawValue === "number" || typeof rawValue === "boolean") {
			picked[key] = rawValue;
			continue;
		}
		if (key === "files" && Array.isArray(rawValue)) {
			picked[key] = rawValue.filter((item): item is string => typeof item === "string").slice(0, 50);
		}
	}

	if (Object.keys(picked).length === 0) {
		for (const [key, value] of Object.entries(args)) {
			if (Object.keys(picked).length >= 8) break;
			if (typeof value === "string") {
				picked[key] = truncateText(value, 400);
			} else if (typeof value === "number" || typeof value === "boolean") {
				picked[key] = value;
			}
		}
	}

	return truncateText(JSON.stringify(picked), DEFAULT_MAX_TOOL_ARGS_CHARS);
}

function extractUserText(msg: UserMessage): string {
	const content = msg.content;
	if (typeof content === "string") return content;

	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function extractAssistantText(msg: AssistantMessage): { text: string; thinking: string } {
	let text = "";
	let thinking = "";

	for (const part of msg.content) {
		if (part.type === "text") {
			text += part.text;
			continue;
		}
		if (part.type === "thinking") {
			thinking += part.thinking;
		}
	}

	return { text, thinking };
}

function formatToolCalls(msg: AssistantMessage): string[] {
	return msg.content
		.filter((c): c is ToolCall => c.type === "toolCall")
		.map((c) => `ToolCall: ${c.name} args=${stringifyArgsCompact(c.arguments as unknown)}`);
}

function extractToolResultText(msg: ToolResultMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

export function formatMessagesForReadThreadDerivation(
	messages: IndexedMessage[],
	options: { maxTranscriptChars: number },
): string {
	const lines: string[] = [];
	let prevIndex: number | null = null;

	for (const item of messages) {
		const index = item.index;
		const msg = item.message;

		if (prevIndex !== null && index > prevIndex + 1) {
			lines.push(`...[skipped messages ${prevIndex + 1}-${index - 1}]...`);
		}
		prevIndex = index;

		if (msg.role === "user") {
			lines.push(`#${index} User: ${truncateText(extractUserText(msg), DEFAULT_MAX_TEXT_CHARS_PER_MESSAGE)}`);
			continue;
		}

		if (msg.role === "assistant") {
			const { text, thinking } = extractAssistantText(msg);
			if (thinking.trim().length > 0) {
				lines.push(`#${index} AssistantThinking: ${truncateText(thinking, DEFAULT_MAX_TEXT_CHARS_PER_MESSAGE)}`);
			}

			const assistantText = truncateText(text, DEFAULT_MAX_TEXT_CHARS_PER_MESSAGE);
			if (assistantText.trim().length > 0) {
				lines.push(`#${index} Assistant: ${assistantText}`);
			}

			for (const toolLine of formatToolCalls(msg)) {
				lines.push(`#${index} ${toolLine}`);
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const toolText = truncateText(extractToolResultText(msg), DEFAULT_MAX_TOOL_RESULT_CHARS);
			lines.push(`#${index} ToolResult(${msg.toolName}): ${toolText}`);
		}
	}

	const transcript = lines.filter((l) => l.trim().length > 0).join("\n");
	if (transcript.length <= options.maxTranscriptChars) return transcript;

	return `...[transcript truncated to last ${options.maxTranscriptChars} chars]\n\n${transcript.slice(-options.maxTranscriptChars)}`;
}
