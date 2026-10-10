/**
 * Mid-run Correction Extension
 *
 * Watches streaming assistant output for a phrase and aborts the in-flight
 * request, then resumes the same run with a corrective reminder instead of
 * ending the turn. Demonstrates ctx.abort(continuation): the aborted partial
 * is discarded, the reminder is injected as a user message, and the session
 * caps repeats via the maxAutoContinuations setting (default 3).
 */

import type { ExtensionAPI, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

const FORBIDDEN_PHRASE = "as an ai language model";

function textOf(message: MessageUpdateEvent["message"]): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

export default function (pi: ExtensionAPI) {
	pi.on("message_update", async (event: MessageUpdateEvent, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!textOf(event.message).toLowerCase().includes(FORBIDDEN_PHRASE)) return;

		ctx.abort({
			reminder: `Rewrite the answer without "${FORBIDDEN_PHRASE}".`,
			contextMode: "discard",
			reason: "midrun-correction",
		});
	});
}
