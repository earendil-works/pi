import type { Context, SystemMessage, Tool, TranscriptContext } from "../types.ts";
import { contentText, getSystemMessageText } from "./text.ts";

export type { TranscriptContext } from "../types.ts";

/** Normalize the top-level initial state into a leading system message. */
export function normalizeContext(context: Context): TranscriptContext {
	const hasSystemPromptField = "systemPrompt" in context;
	const hasToolsField = "tools" in context;

	if (!hasSystemPromptField && !hasToolsField) {
		return context as TranscriptContext;
	}

	const systemPrompt = context.systemPrompt;
	const tools = context.tools;
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;

	if (!hasSystemPrompt && !hasTools) {
		return { messages: context.messages } as TranscriptContext;
	}

	const initialMessage: SystemMessage = {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};

	return { messages: [initialMessage, ...context.messages] } as TranscriptContext;
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(context: TranscriptContext): SystemMessage | undefined {
	const first = context.messages[0];
	return first?.role === "system" ? first : undefined;
}

/** Return tools declared by the leading system message. */
export function getInitialTools(context: TranscriptContext): Tool[] {
	return getInitialSystemMessage(context)?.toolsAdded ?? [];
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(context: TranscriptContext): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/** Return a context without its leading system message. */
export function withoutInitialSystemMessage(context: TranscriptContext): TranscriptContext {
	return getInitialSystemMessage(context) ? ({ messages: context.messages.slice(1) } as TranscriptContext) : context;
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(context: TranscriptContext): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(context);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(context: TranscriptContext): string {
	const message = getCurrentSystemMessage(context);
	return message ? getSystemMessageText(message) : "";
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}
