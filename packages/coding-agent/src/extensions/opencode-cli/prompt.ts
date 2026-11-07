import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, ImageContent, Message, TextContent, Tool, ToolCall } from "@earendil-works/pi-ai";
import { safeJson } from "./json.ts";

function contentToText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((item) => {
			if (item.type === "text") return item.text;
			return `[image in conversation: ${item.mimeType}, ${item.data.length} base64 chars]`;
		})
		.join("\n");
}

export function imageContentsForModel(messages: Message[], supportsImages: boolean): ImageContent[] {
	if (!supportsImages) return [];

	const images: ImageContent[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "toolResult") continue;
		if (typeof message.content === "string") continue;
		for (const content of message.content) {
			if (content.type === "image") images.push(content);
		}
	}
	return images;
}

function safeImageExtension(mimeType: string): string {
	const extensions: Record<string, string> = {
		"image/avif": ".avif",
		"image/bmp": ".bmp",
		"image/gif": ".gif",
		"image/jpeg": ".jpg",
		"image/png": ".png",
		"image/webp": ".webp",
	};
	return extensions[mimeType.toLowerCase()] ?? ".bin";
}

export async function writeImageFiles(images: ImageContent[], directory: string): Promise<string[]> {
	const imageDir = join(directory, "pi-images");
	if (images.length > 0) await mkdir(imageDir, { recursive: true });
	return Promise.all(
		images.map(async (image, index) => {
			if (!image.mimeType.toLowerCase().startsWith("image/")) {
				throw new Error(`Unsupported image MIME type: ${image.mimeType}`);
			}
			const base64 = image.data.replace(/\s/g, "");
			if (!base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
				throw new Error(`Invalid base64 data for image ${index + 1}`);
			}
			const data = Buffer.from(base64, "base64");
			if (data.length === 0) {
				throw new Error(`Empty image data for image ${index + 1}`);
			}
			const path = join(
				imageDir,
				`image-${String(index + 1).padStart(3, "0")}${safeImageExtension(image.mimeType)}`,
			);
			await writeFile(path, data);
			return path;
		}),
	);
}

function serializeMessage(message: Message): string {
	if (message.role === "user" || message.role === "system") {
		return `${message.role.toUpperCase()}:\n${contentToText(message.content)}`;
	}

	if (message.role === "toolResult") {
		return [
			`PI TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
			contentToText(message.content),
		].join("\n");
	}

	const parts = message.content.map((part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
		if (part.type === "text") return part.text;
		if (part.type === "thinking") return `<thinking>${part.thinking}</thinking>`;
		return `<pi_tool_call>${safeJson({ id: part.id, name: part.name, arguments: part.arguments })}</pi_tool_call>`;
	});
	return `ASSISTANT:\n${parts.join("\n")}`;
}

export function serializeTools(tools?: Tool[]): string {
	if (!tools || tools.length === 0) return "No Pi tools are available for this turn.";
	return safeJson(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);
}

export function buildPrompt(context: Context): string {
	const sections: string[] = [];
	sections.push(`# Pi/OpenCode bridge instructions

You are being used as the model backend for Pi Coding Agent through the OpenCode CLI.
OpenCode's own tools are disabled. Do not try to use OpenCode tools.

If you need Pi to run a tool, your entire response must contain only one or more tool-call blocks separated by whitespace:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only exact tool names listed in the "Available Pi tools" section.
- The JSON inside every marker must be valid JSON with a string "name" and an object "arguments".
- Escape every quote inside a JSON string value as \\", especially quotes inside shell commands.
- Markers are bridge control syntax. Never quote them, explain them, put them in prose, or wrap them in Markdown fences.
- Never output a marker as an example. A marker means you are requesting immediate execution.
- Do not put any text before or after tool-call markers. Mixed prose and markers will not execute.
- NEVER use XML-style tool-use syntax (e.g., <bash>, <read>, <glob>, <grep>, <edit>, <task>, <arg_key>, <arg_value>). These are your native tool-use format and are completely disabled.
- NEVER use Claude Code XML-style markup (e.g., <bash command="...">, <read path="...">, <arg_key>, <arg_value>). This is not a tool-call and will be treated as plain text.
- If you can answer without a tool, answer normally in plain text and do not emit any marker.
- After Pi returns tool results, match them to prior tool-call IDs in the transcript, then either answer or request another Pi tool call.`);

	if (context.systemPrompt?.trim()) {
		sections.push(`# Pi system prompt

${context.systemPrompt}`);
	}

	sections.push(`# Available Pi tools

${serializeTools(context.tools)}`);

	if (context.messages.length > 0) {
		sections.push(`# Conversation transcript

${context.messages.map(serializeMessage).join("\n\n---\n\n")}`);
	} else {
		sections.push("# Conversation transcript\n\n(no prior messages)");
	}

	sections.push("Now produce the next assistant message for Pi.");
	return sections.join("\n\n---\n\n");
}

export function serializedTranscriptParts(messages: Message[]): string[] {
	return messages.map(serializeMessage);
}

export function buildContinuationPrompt(deltaParts: string[]): string {
	return [
		"# Continued Pi/OpenCode bridge turn",
		"",
		"This message continues your existing OpenCode session: the Pi system prompt,",
		"tool list, and earlier transcript are already in context. Do not ask for them again.",
		"If you need Pi to run a tool, your entire response must contain only one or more",
		"tool-call blocks separated by whitespace:",
		'<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>',
		"Use only exact tool names from the earlier tool list. Never quote markers, explain",
		"them, or wrap them in Markdown fences. If you can answer without a tool, answer normally.",
		"",
		"# New transcript since your last response",
		"",
		deltaParts.join("\n\n---\n\n"),
		"",
		"Now produce the next assistant message for Pi.",
	].join("\n");
}
