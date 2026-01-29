import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@kennyfrc/mu-ai";

const MAX_TEXT_CHARS_PER_MESSAGE = 2000;
const MAX_TOOL_RESULT_CHARS = 500;
const MAX_TOOL_ARGS_CHARS = 800;
const MAX_TRANSCRIPT_CHARS = 40_000;

function truncateText(raw: string, maxChars: number): string {
	if (raw.length <= maxChars) return raw;
	return `${raw.slice(0, maxChars)}...`;
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
	] as const;

	const picked: Record<string, unknown> = {};

	for (const key of allowKeys) {
		if (!(key in args)) continue;
		const rawValue = args[key];
		if (typeof rawValue === "string") {
			picked[key] = truncateText(rawValue, key === "input" ? 200 : 300);
			continue;
		}
		if (typeof rawValue === "number" || typeof rawValue === "boolean") {
			picked[key] = rawValue;
			continue;
		}
		if (key === "files" && Array.isArray(rawValue)) {
			picked[key] = rawValue.filter((item): item is string => typeof item === "string").slice(0, 25);
		}
	}

	if (Object.keys(picked).length === 0) {
		// Fallback: include the first few primitive args so we don't end up with an empty blob.
		for (const [key, value] of Object.entries(args)) {
			if (Object.keys(picked).length >= 8) break;
			if (typeof value === "string") {
				picked[key] = truncateText(value, 200);
			} else if (typeof value === "number" || typeof value === "boolean") {
				picked[key] = value;
			}
		}
	}

	return truncateText(JSON.stringify(picked), MAX_TOOL_ARGS_CHARS);
}

function formatUserMessage(msg: UserMessage): string {
	const content = msg.content;
	if (typeof content === "string") {
		return `User: ${truncateText(content, MAX_TEXT_CHARS_PER_MESSAGE)}`;
	}

	const text = content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");

	return `User: ${truncateText(text, MAX_TEXT_CHARS_PER_MESSAGE)}`;
}

function formatAssistantMessage(msg: AssistantMessage): string {
	const textParts = msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");

	const toolCalls = msg.content
		.filter((c): c is ToolCall => c.type === "toolCall")
		.map((c) => `[ToolCall ${c.name} args=${stringifyArgsCompact(c.arguments as unknown)}]`)
		.join(" ");

	const textLine = `Assistant: ${truncateText(textParts, MAX_TEXT_CHARS_PER_MESSAGE)}`;
	return toolCalls ? `${textLine}\n${toolCalls}` : textLine;
}

function formatToolResultMessage(msg: ToolResultMessage): string {
	const text = msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	return `Tool (${msg.toolName}): ${truncateText(text, MAX_TOOL_RESULT_CHARS)}`;
}

/**
 * Compact transcript used for the *handoff file selection* model call.
 *
 * Critical: includes tool-call arguments (especially Read.path) because tool results often omit paths.
 */
export function formatMessagesForHandoffSelection(messages: Message[]): string {
	const lines: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			lines.push(formatUserMessage(msg));
			continue;
		}

		if (msg.role === "assistant") {
			lines.push(formatAssistantMessage(msg));
			continue;
		}

		if (msg.role === "toolResult") {
			lines.push(formatToolResultMessage(msg));
		}
	}

	const transcript = lines.filter((line) => line.length > 0).join("\n\n");
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;

	// Keep the most recent context; handoff selection should bias towards recent work when near the context limit.
	return `...[transcript truncated to last ${MAX_TRANSCRIPT_CHARS} chars]\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
}
