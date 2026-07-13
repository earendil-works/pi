import type { DeveloperMessage, Message, UserMessage } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const SYNTHETIC_DEVELOPER_MESSAGE_PREFIX = `<developer_message>
The following instruction was provided by the application developer and applies from this point forward:

`;
export const SYNTHETIC_DEVELOPER_MESSAGE_SUFFIX = `
</developer_message>`;

export function developerMessageToUserMessage(message: DeveloperMessage): UserMessage {
	return {
		role: "user",
		content: `${SYNTHETIC_DEVELOPER_MESSAGE_PREFIX}${sanitizeSurrogates(message.content)}${SYNTHETIC_DEVELOPER_MESSAGE_SUFFIX}`,
		timestamp: message.timestamp,
	};
}

export function downgradeDeveloperMessages(messages: Message[]): Message[] {
	return messages.map((message) => (message.role === "developer" ? developerMessageToUserMessage(message) : message));
}
