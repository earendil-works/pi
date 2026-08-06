import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, contentText, type Message, type Model } from "@earendil-works/pi-ai";
import { type MemoryStore, SUMMARY_TAG } from "./store.ts";

const DEFAULT_MEMORY_LIMIT = 5;

/**
 * Build the per-turn memory section injected into the system prompt: the
 * rolling conversation summary plus memories relevant to the current message.
 * Returns an empty string when no memories exist.
 */
export function buildMemorySection(store: MemoryStore, query: string, limit = DEFAULT_MEMORY_LIMIT): string {
	const parts: string[] = [];
	const summary = store.findByTag(SUMMARY_TAG);
	if (summary) {
		parts.push(`## Conversation so far\n${summary.text}`);
	}
	const memories = store.search(query, limit, [SUMMARY_TAG]);
	if (memories.length > 0) {
		parts.push(`## Relevant memories\n${memories.map((entry) => `- ${entry.text}`).join("\n")}`);
	}
	return parts.length > 0 ? parts.join("\n\n") : "";
}

const SUMMARY_SYSTEM_PROMPT = `You are a story archivist for a roleplay session. Summarize the conversation below into a compact memory note the character can later recall. Include: who the character is, who the user is, key relationships, important events, the current location and situation, and anything the user revealed about themselves. Keep it under 200 words and write in the same language as the conversation.`;

export interface SummarizeOptions {
	apiKey?: string;
	characterName?: string;
}

export async function summarizeConversation(
	model: Model<Api>,
	streamFn: StreamFn,
	messages: AgentMessage[],
	options: SummarizeOptions = {},
): Promise<string> {
	const transcript = messages
		.map((message) => {
			if (message.role === "user") {
				return `User: ${contentText(message.content)}`;
			}
			if (message.role === "assistant") {
				return `${options.characterName ?? "Character"}: ${contentText(message.content)}`;
			}
			if (message.role === "toolResult") {
				return `[${message.toolName}]: ${contentText(message.content)}`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
	const context = {
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		messages: [{ role: "user", content: transcript, timestamp: Date.now() }] satisfies Message[],
	};
	const response = await streamFn(model, context, { apiKey: options.apiKey });
	const result = await response.result();
	return contentText(result.content);
}
