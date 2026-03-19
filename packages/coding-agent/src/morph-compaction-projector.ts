import { getMuCompactResponseItem, type Message } from "@kennyfrc/mu-ai";

const USER_MESSAGE_TIME_PREFIX_PATTERN = /^(?:<user_message_time>[\s\S]*?<\/user_message_time>(?:\n\n|\n)?)+/;

export type MorphProjectedMessage = {
	role: "user" | "assistant";
	content: string;
};

type CompactReplayRecord = {
	type?: unknown;
};

function stripUserMessageTimePrefix(text: string): string {
	return text.replace(USER_MESSAGE_TIME_PREFIX_PATTERN, "").trim();
}

function normalizeWhitespaceLines(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function extractUserText(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") {
		return stripUserMessageTimePrefix(message.content);
	}

	const text = message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");

	return stripUserMessageTimePrefix(text);
}

function extractToolResultText(message: Extract<Message, { role: "toolResult" }>): string {
	return normalizeWhitespaceLines(
		message.content
			.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n\n"),
	);
}

function projectAssistantMessage(message: Extract<Message, { role: "assistant" }>): string {
	const parts: string[] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			parts.push("Thinking:\n" + normalizeWhitespaceLines(block.thinking));
			continue;
		}

		if (block.type === "text") {
			parts.push("Assistant:\n" + normalizeWhitespaceLines(block.text));
			continue;
		}

		parts.push(`ToolCall(${block.name}): ${JSON.stringify(block.arguments)}`);
	}

	return parts.join("\n\n").trim();
}

function transcriptLinesForAssistant(message: Extract<Message, { role: "assistant" }>): string[] {
	const lines: string[] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			const thinking = normalizeWhitespaceLines(block.thinking);
			const thinkingLines = thinking.split("\n");
			if (thinkingLines.length > 0) {
				lines.push(`AssistantThinking: ${thinkingLines[0]}`);
				for (const line of thinkingLines.slice(1)) {
					lines.push(line);
				}
			}
			continue;
		}

		if (block.type === "text") {
			const text = normalizeWhitespaceLines(block.text);
			const textLines = text.split("\n");
			if (textLines.length > 0) {
				lines.push(`Assistant: ${textLines[0]}`);
				for (const line of textLines.slice(1)) {
					lines.push(line);
				}
			}
			continue;
		}

		lines.push(`ToolCall(${block.name}): ${JSON.stringify(block.arguments)}`);
	}

	return lines;
}

function firstActionableLine(text: string): string | null {
	for (const rawLine of stripUserMessageTimePrefix(text).split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^(?:[#>*`-]|\d+\.)/.test(line)) continue;
		return line;
	}

	return null;
}

export function containsNativeCompactReplay(messages: Message[]): boolean {
	return messages.some((message) => {
		const item = getMuCompactResponseItem(message);
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return false;
		}

		const compactItem = item as CompactReplayRecord;
		return compactItem.type === "compaction" || compactItem.type === "compaction_summary";
	});
}

export function normalizeMorphCompactionQuery(args: { messages: Message[]; explicitGoal?: string | null }): string {
	const explicitGoal = args.explicitGoal?.trim();
	if (explicitGoal) {
		return explicitGoal;
	}

	for (const message of [...args.messages].reverse()) {
		if (message.role !== "user") continue;
		const actionable = firstActionableLine(extractUserText(message));
		if (actionable) {
			return actionable;
		}
	}

	return "Continue the task from the compacted checkpoint.";
}

export function projectMessagesToMorphMessages(messages: Message[]): MorphProjectedMessage[] {
	const projected: MorphProjectedMessage[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const content = extractUserText(message);
			if (content) {
				projected.push({ role: "user", content });
			}
			continue;
		}

		if (message.role === "assistant") {
			const content = projectAssistantMessage(message);
			if (content) {
				projected.push({ role: "assistant", content });
			}
			continue;
		}

		const content = extractToolResultText(message);
		if (content) {
			projected.push({
				role: "assistant",
				content: `ToolResult(${message.toolName}):\n${content}`,
			});
		}
	}

	return projected;
}

export function projectMessagesToMorphTranscript(messages: Message[]): string {
	const lines: string[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const text = extractUserText(message);
			if (!text) continue;
			const userLines = text.split("\n");
			lines.push(`User: ${userLines[0] ?? ""}`);
			lines.push(...userLines.slice(1));
			continue;
		}

		if (message.role === "assistant") {
			lines.push(...transcriptLinesForAssistant(message));
			continue;
		}

		const toolText = extractToolResultText(message);
		if (!toolText) continue;
		const toolLines = toolText.split("\n");
		lines.push(`ToolResult(${message.toolName}): ${toolLines[0] ?? ""}`);
		lines.push(...toolLines.slice(1));
	}

	return lines.join("\n").trim();
}
