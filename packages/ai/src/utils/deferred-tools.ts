import type { Context, Tool } from "../types.ts";

/** Split current tools into prefix and transcript-loaded definitions. */
export function splitDeferredTools(
	context: Context,
	enabled: boolean,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
	const tools = context.tools ?? [];
	if (!enabled) return { immediate: tools, deferred: new Map() };

	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(block.name);
			}
		} else if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				if (!usedNames.has(name)) deferredNames.add(name);
			}
		}
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const tool of tools) {
		if (deferredNames.has(tool.name)) deferred.set(tool.name, tool);
		else immediate.push(tool);
	}
	return { immediate, deferred };
}
