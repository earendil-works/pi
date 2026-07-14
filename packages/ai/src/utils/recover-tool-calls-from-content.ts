import type { AssistantMessage, Tool, ToolCall } from "../types.ts";

export interface RecoveredToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Ollama and other OpenAI-compatible local servers often return syntactically valid tool-call JSON in
 * assistant `content` while leaving the structured `tool_calls` stream field empty. pi-agent-core only
 * dispatches tools from `toolCall` content blocks, so this recovery pass lifts JSON-shaped tool calls
 * out of plain text when the model was offered tools but emitted no native toolCall blocks.
 */
export function extractKnownToolNames(tools: Tool[] | undefined): Set<string> {
	const names = new Set<string>();
	if (!tools) {
		return names;
	}
	for (const tool of tools) {
		if (typeof tool.name === "string" && tool.name.trim().length > 0) {
			names.add(tool.name.trim());
		}
	}
	return names;
}

function stripToolCallWrappers(text: string): string {
	let trimmed = text.trim();
	const xmlMatch = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
	if (xmlMatch) {
		trimmed = xmlMatch[1]!.trim();
	}
	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenceMatch) {
		trimmed = fenceMatch[1]!.trim();
	}
	return trimmed;
}

function normalizeArguments(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null) {
		return {};
	}
	if (typeof value === "string") {
		const parsed = tryParseJson(value.trim());
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function coerceRecoveredToolCall(candidate: unknown, knownToolNames: Set<string>): RecoveredToolCall | undefined {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		return undefined;
	}
	const row = candidate as Record<string, unknown>;

	const fn = row.function;
	if (fn && typeof fn === "object" && !Array.isArray(fn)) {
		const fnRow = fn as Record<string, unknown>;
		const name = typeof fnRow.name === "string" ? fnRow.name.trim() : "";
		if (!name || !knownToolNames.has(name)) {
			return undefined;
		}
		const args = normalizeArguments(fnRow.arguments);
		if (args === undefined) {
			return undefined;
		}
		const id = typeof row.id === "string" && row.id.trim().length > 0 ? row.id.trim() : createRecoveredToolCallId(name);
		return { id, name, arguments: args };
	}

	const name = typeof row.name === "string" ? row.name.trim() : "";
	if (!name || !knownToolNames.has(name)) {
		return undefined;
	}
	const args = normalizeArguments(row.arguments ?? row.parameters ?? row.input);
	if (args === undefined) {
		return undefined;
	}
	const id = typeof row.id === "string" && row.id.trim().length > 0 ? row.id.trim() : createRecoveredToolCallId(name);
	return { id, name, arguments: args };
}

function parseRecoveredToolCallsFromText(text: string, knownToolNames: Set<string>): RecoveredToolCall[] {
	if (knownToolNames.size === 0) {
		return [];
	}
	const normalized = stripToolCallWrappers(text);
	if (normalized.length === 0) {
		return [];
	}

	const parsed = tryParseJson(normalized);
	if (parsed === undefined) {
		return [];
	}

	if (Array.isArray(parsed)) {
		const recovered: RecoveredToolCall[] = [];
		for (const entry of parsed) {
			const toolCall = coerceRecoveredToolCall(entry, knownToolNames);
			if (toolCall) {
				recovered.push(toolCall);
			}
		}
		return recovered;
	}

	const single = coerceRecoveredToolCall(parsed, knownToolNames);
	return single ? [single] : [];
}

export function createRecoveredToolCallId(name: string): string {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `recovered_${name}_${suffix}`;
}

export function assistantMessageHasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall");
}

export function recoverToolCallsFromText(text: string, tools: Tool[] | undefined): RecoveredToolCall[] {
	return parseRecoveredToolCallsFromText(text, extractKnownToolNames(tools));
}

export interface RecoverToolCallsFromContentResult {
	recovered: RecoveredToolCall[];
	remainingText: string;
}

export function recoverToolCallsFromContentText(
	text: string,
	tools: Tool[] | undefined,
): RecoverToolCallsFromContentResult {
	const recovered = recoverToolCallsFromText(text, tools);
	if (recovered.length === 0) {
		return { recovered: [], remainingText: text };
	}
	const normalized = stripToolCallWrappers(text.trim());
	const parsed = tryParseJson(normalized);
	if (parsed === undefined) {
		return { recovered: [], remainingText: text };
	}
	return { recovered, remainingText: "" };
}

export function applyRecoveredToolCallsToAssistantMessage(
	message: AssistantMessage,
	tools: Tool[] | undefined,
): boolean {
	if (assistantMessageHasToolCalls(message)) {
		return false;
	}
	if (!tools || tools.length === 0) {
		return false;
	}

	const nextContent: AssistantMessage["content"] = [];
	let recoveredAny = false;

	for (const block of message.content) {
		if (block.type !== "text") {
			nextContent.push(block);
			continue;
		}

		const { recovered, remainingText } = recoverToolCallsFromContentText(block.text, tools);
		if (recovered.length === 0) {
			nextContent.push(block);
			continue;
		}

		recoveredAny = true;
		if (remainingText.trim().length > 0) {
			nextContent.push({ type: "text", text: remainingText });
		}
		for (const toolCall of recovered) {
			nextContent.push({
				type: "toolCall",
				id: toolCall.id,
				name: toolCall.name,
				arguments: toolCall.arguments,
			} satisfies ToolCall);
		}
	}

	if (!recoveredAny) {
		return false;
	}

	message.content.splice(0, message.content.length, ...nextContent);
	if (message.stopReason === "stop") {
		message.stopReason = "toolUse";
	}
	return true;
}
