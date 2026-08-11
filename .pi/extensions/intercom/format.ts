/**
 * Presentation for delivered intercom traffic. Pure string building, no I/O, so the
 * exact text the LLM sees is pinned by unit tests.
 */

import type { IntercomMessage } from "./store.ts";

export function senderLabel(message: IntercomMessage): string {
	const short = message.sender.slice(0, 8);
	return message.alias ? `${message.alias} (${short})` : short;
}

/**
 * The banner line is first and stands alone: the TUI renderer splits it off for
 * highlighting, mirroring the handoff memo's layout.
 */
export function formatIncoming(channel: string, messages: IntercomMessage[]): string {
	const plural = messages.length === 1 ? "message" : "messages";
	const lines = [`Intercom #${channel} — ${messages.length} new ${plural}`];
	for (const message of messages) {
		lines.push("", `From ${senderLabel(message)} at ${message.created}:`, message.text.trimEnd());
	}
	return lines.join("\n");
}
