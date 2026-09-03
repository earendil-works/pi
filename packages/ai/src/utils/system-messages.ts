import type { Api, Message, Model, SystemMessage } from "../types.ts";

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

/**
 * Whether the transport delivers a mid-conversation system message with a system-level role.
 *
 * Transports that answer false render it as a tagged user turn instead. That is fine for
 * messages a caller emits deliberately, but a harness that patches its prompt incrementally
 * should prefer replacing the top-level system prompt on those models, since a user turn
 * carrying operator instructions is untested territory for them.
 *
 * `compat.supportsMidConvoSystemMessages` wins when set, so custom providers can opt in.
 */
export function supportsMidConversationSystemMessages(model: Model<Api>): boolean {
	const compat = model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined;
	if (compat?.supportsMidConvoSystemMessages !== undefined) return compat.supportsMidConvoSystemMessages;
	switch (model.api) {
		case "openai-completions":
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
		case "mistral-conversations":
			return true;
		default:
			// anthropic-messages needs the generated compat flag; Google, Bedrock, pi-messages and
			// custom APIs either render system messages as user text or have unknown behavior.
			return false;
	}
}

/** Names of tools that become available at this message, from either a system update or a tool-result marker. */
export function addedToolNames(message: Message): string[] {
	if (message.role === "system") return (message.toolsAdded ?? []).map((tool) => tool.name);
	if (message.role === "toolResult") return [...new Set(message.addedToolNames ?? [])];
	return [];
}
