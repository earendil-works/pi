import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

export interface SessionSearchPart {
	role: string;
	kind: "name" | "text" | "thinking" | "toolCall";
	text: string;
}

/** Extract the text fragments mirrored into the session FTS index. */
export function sessionSearchParts(entry: SessionTreeEntry): SessionSearchPart[] {
	if (entry.type === "session_info") {
		return entry.name ? [{ role: "meta", kind: "name", text: entry.name }] : [];
	}
	if (entry.type !== "message") return [];

	if (!("content" in entry.message)) return [];
	const role = entry.message.role;
	const content = entry.message.content;
	if (typeof content === "string") {
		return content ? [{ role, kind: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) return [];

	const parts: SessionSearchPart[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push({ role, kind: "text", text: block.text });
		} else if (block.type === "thinking" && block.thinking) {
			parts.push({ role, kind: "thinking", text: block.thinking });
		} else if (block.type === "toolCall") {
			parts.push({ role, kind: "toolCall", text: `${block.name} ${JSON.stringify(block.arguments ?? {})}` });
		}
	}
	return parts;
}
