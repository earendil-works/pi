import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { type MemoryStore, SUMMARY_TAG } from "./store.ts";

const searchSchema = Type.Object({
	query: Type.String({
		description: "What you want to recall. Be specific about the topic, person, or detail.",
	}),
});

const rememberSchema = Type.Object({
	text: Type.String({
		description: "The fact or event to remember, written as a clear statement.",
	}),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional keywords to help find this memory later.",
		}),
	),
});

export function createMemorySearchTool(store: MemoryStore): AgentTool<typeof searchSchema> {
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Recall your past experiences, things the user told you, or story events. Searches your long-term memory and returns matching memories. Use this when you are unsure about something you should already know.",
		parameters: searchSchema,
		async execute(_toolCallId, { query }) {
			const results = store.search(query, 5, [SUMMARY_TAG]);
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No memories found for that query." }], details: undefined };
			}
			const text = results.map((entry) => `- ${entry.text}`).join("\n");
			return { content: [{ type: "text", text: `Memories:\n${text}` }], details: undefined };
		},
	};
}

export function createMemoryRememberTool(store: MemoryStore): AgentTool<typeof rememberSchema> {
	return {
		name: "memory_remember",
		label: "memory_remember",
		description:
			"Store an important fact or event into your long-term memory, such as something the user told you or a meaningful story development you want to recall later.",
		parameters: rememberSchema,
		async execute(_toolCallId, { text, tags }) {
			store.add(text, tags ?? []);
			return { content: [{ type: "text", text: "Remembered." }], details: undefined };
		},
	};
}

export type MemorySearchToolInput = Static<typeof searchSchema>;
export type MemoryRememberToolInput = Static<typeof rememberSchema>;
