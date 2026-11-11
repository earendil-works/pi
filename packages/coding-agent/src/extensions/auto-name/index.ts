// Give unnamed chats one background-generated title without storing naming prompts in their conversation.
import { randomUUID } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { generateDisplayName } from "../../core/naming.ts";

const marker = "pi.auto-name";

/** Name unnamed chats after their first completed answer, preserving every explicit session name. */
export function createAutoNameExtension(): ExtensionFactory {
	return (pi) => {
		let lifetime = new AbortController();
		let controller: AbortController | undefined;
		let pending: Promise<void> | undefined;
		let attempted = false;

		pi.on("session_start", () => {
			if (lifetime.signal.aborted) {
				lifetime = new AbortController();
				attempted = false;
			}
		});
		pi.on("session_info_changed", () => {
			attempted = true;
			controller?.abort();
		});
		pi.on("agent_end", (event, ctx) => {
			if (attempted || lifetime.signal.aborted || !ctx.model) return;
			const entries = ctx.sessionManager.getEntries();
			if (
				entries.some(
					(entry) => entry.type === "session_info" || (entry.type === "custom" && entry.customType === marker),
				)
			) {
				attempted = true;
				return;
			}
			const answer = event.messages.findLast(
				(message) =>
					message.role === "assistant" && message.stopReason === "stop" && contentText(message.content).trim(),
			);
			if (!answer || answer.role !== "assistant") return;
			const question = ctx.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			const firstQuestion =
				question?.type === "message" && question.message.role === "user"
					? contentText(question.message.content)
					: "";
			const model = ctx.model;
			const owner = lifetime;
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const naming = new AbortController();
			controller = naming;
			pi.appendEntry(marker, { status: "pending" });
			attempted = true;
			pending = (async () => {
				const result = await generateDisplayName(ctx.modelRegistry.runtime, model, {
					kind: "chat",
					subject: JSON.stringify({
						request: firstQuestion.slice(0, 6000),
						firstAnswer: contentText(answer.content).slice(0, 6000),
					}),
					instructions: ctx.getSystemPrompt(),
					sessionId: `name:chat:${randomUUID()}`,
					signal: AbortSignal.any([owner.signal, naming.signal]),
				});
				if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile)
					return;
				if (result.response) {
					const response = result.response;
					pi.appendUsage("chat_name", response.provider, response.model, response.usage);
				}
				// A manual rename or explicit clear can arrive while the naming request is running.
				if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_info")) {
					pi.appendEntry(marker, { status: "superseded" });
					return;
				}
				if (owner.signal.aborted) {
					pi.appendEntry(marker, { status: "failed", error: "Name generation canceled" });
					return;
				}
				if (result.status === "generated") {
					pi.setSessionName(result.name);
					pi.appendEntry(marker, { status: "generated" });
				} else pi.appendEntry(marker, { status: "failed", error: result.error });
			})()
				.catch((error: unknown) => {
					if (!owner.signal.aborted) ctx.ui.notify(`Cannot name this chat: ${String(error)}`, "warning");
				})
				.finally(() => {
					pending = undefined;
					controller = undefined;
				});
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			// Print/JSON callers have already received their answer, but may exit immediately.
			// Finish their bounded metadata work; interactive switches and shutdowns cancel it.
			if (ctx.mode === "print" || ctx.mode === "json") await pending;
			lifetime.abort();
			await pending;
		});
	};
}

export default createAutoNameExtension();
