import type { Message, SystemMessage } from "../types.ts";

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

/** Names of tools that become available at this message, from either a system update or a tool-result marker. */
export function addedToolNames(message: Message): string[] {
	if (message.role === "system") return (message.toolsAdded ?? []).map((tool) => tool.name);
	if (message.role === "toolResult") return [...new Set(message.addedToolNames ?? [])];
	return [];
}
