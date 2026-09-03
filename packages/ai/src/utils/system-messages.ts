import type { Message, SystemMessage, Tool } from "../types.ts";

export interface ResolvedToolChange {
	added: Tool[];
	removed: Tool[];
	addedNames: string[];
}

export function getSystemMessageText(message: SystemMessage): string {
	return typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
}

/**
 * Render a system message as user text for transports without mid-conversation
 * system messages. The tag tells the model the text is operator context rather
 * than end-user input. Appending it keeps the cached prefix intact.
 */
export function renderSystemMessageAsUserText(message: SystemMessage): string {
	const text = getSystemMessageText(message);
	return text.length > 0 ? `<system_update>\n${text}\n</system_update>` : "";
}

export function getSystemMessageToolChange(message: SystemMessage): ResolvedToolChange {
	const added = message.toolsAdded ?? [];
	const removed = message.toolsRemoved ?? [];
	return {
		added,
		removed,
		addedNames: added.map((tool) => tool.name),
	};
}

/** Normalize first-class system updates and tool-result additions into one chronological change. */
export function resolveMessageToolChange(
	message: Message,
	resolveTool: (name: string) => Tool | undefined = () => undefined,
): ResolvedToolChange {
	if (message.role === "system") return getSystemMessageToolChange(message);
	if (message.role === "toolResult") {
		const addedNames = [...new Set(message.addedToolNames ?? [])];
		return {
			added: addedNames.flatMap((name) => {
				const tool = resolveTool(name);
				return tool ? [tool] : [];
			}),
			removed: [],
			addedNames,
		};
	}
	return { added: [], removed: [], addedNames: [] };
}
