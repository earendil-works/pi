import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/** Extract the instruction text carried by a system message. */
export function getSystemMessageText(message: SystemMessage): string {
	return contentText(message.content);
}

/** Render a later system message for APIs without a native system role. */
export function renderSystemMessageAsUserText(message: SystemMessage): string {
	const text = getSystemMessageText(message);
	return text ? `<system_reminder>\n${text}\n</system_reminder>` : "";
}
