// Chat's TUI commands (p2-tui-port.md section 6.3), ported from the p2.* actions to pi's ids. They reach the live
// surface through `ctx.surface("chat")`, so a facet reload never leaves a stale handler.
import type { TuiCommand, TuiContext } from "@p2/app/v1/tui";
import { ChatSurface } from "./tui.ts";

const chat = (ctx: TuiContext): ChatSurface | undefined => {
	const surface = ctx.surface("chat");
	return surface instanceof ChatSurface ? surface : undefined;
};

export const CHAT_COMMANDS: Record<string, TuiCommand> = {
	"app.interrupt": {
		title: "Stop the agent",
		category: "Chat",
		// pi: Escape closes the editor's autocomplete first, and aborts a running compaction.
		when: "chat && participant && !autocomplete && !overlay",
		run: (ctx) => chat(ctx)?.interrupt(),
	},
	"app.clear": {
		title: "Clear editor",
		category: "Chat",
		// pi: Ctrl+C clears the editor; a second press within 500 ms exits (ChatSurface.clear).
		when: "chat && editorFocused && !autocomplete && !overlay",
		run: (ctx) => chat(ctx)?.clear(),
	},
	"app.message.followUp": {
		title: "Queue follow-up message",
		category: "Chat",
		when: "chat && participant && !overlay",
		run: (ctx) => chat(ctx)?.send("followUp"),
	},
	"app.message.dequeue": {
		title: "Restore your queued messages",
		category: "Chat",
		when: "chat && participant && !overlay",
		run: (ctx) => chat(ctx)?.dequeueOwn(),
	},
	"p2.chat.compact": {
		title: "Compact the context",
		category: "Session",
		when: "chat && participant && !overlay",
		slash: { name: "compact", argumentHint: "[instructions]" },
		run: (ctx, args) => chat(ctx)?.compact(args),
	},
	// pi's /fork and /clone as new sessions (Sessions.fork/clone; the server copies the store).
	"app.session.fork": {
		title: "Fork from a message into a new session",
		category: "Session",
		when: "chat && owner && !overlay",
		slash: { name: "fork" },
		run: (ctx) => chat(ctx)?.openFork(),
	},
	"p2.session.clone": {
		title: "Clone the session",
		category: "Session",
		when: "chat && owner && !overlay",
		slash: { name: "clone" },
		run: (ctx) => chat(ctx)?.cloneSession(),
	},
	"p2.chat.newContext": {
		title: "Start a new context",
		category: "Session",
		when: "chat && participant && owner && !overlay",
		slash: { name: "new-context", argumentHint: "[handoff]" },
		run: (ctx, args) => chat(ctx)?.newContext(args),
	},
	// P9: local files reach the server only through the launcher (its picker or a confirmation of the path).
	"p2.chat.attach": {
		title: "Attach a local file",
		category: "Chat",
		when: "chat && participant && !overlay",
		slash: { name: "attach", argumentHint: "[path]" },
		run: async (ctx, args) => {
			const result = await ctx.grant("attach", args ? { path: args } : {});
			const file = result.ok ? parseUpload(result.value) : undefined;
			if (file) chat(ctx)?.addAttachment(file);
			else if (!result.ok && result.error !== "denied") ctx.notify(`Not attached (${result.error})`, "warning");
		},
	},
	"p2.chat.detach": {
		title: "Remove the last attachment",
		category: "Chat",
		keys: "backspace",
		when: "chat && participant && editorEmpty && attachments && !overlay",
		run: (ctx) => chat(ctx)?.detach(),
	},
	"p2.chat.detachAll": {
		title: "Remove all attachments",
		category: "Chat",
		when: "chat && participant && attachments && !overlay",
		slash: { name: "detach" },
		run: (ctx) => chat(ctx)?.detach(true),
	},
	// pi's /copy (P5): the launcher shows the full text and copies only after a local confirmation (C grant).
	"p2.chat.copy": {
		title: "Copy the last answer",
		category: "Chat",
		when: "chat && !overlay",
		slash: { name: "copy" },
		run: async (ctx) => {
			const text = chat(ctx)?.lastAssistantText();
			if (!text) {
				ctx.notify("Nothing to copy yet", "warning");
				return;
			}
			const result = await ctx.grant("copy", { text: text.slice(0, 1024 * 1024), label: "the last answer" });
			if (!result.ok && result.error !== "denied") ctx.notify(`Not copied (${result.error})`, "warning");
		},
	},
};

/** An upload the launcher made (P9): the server's upload ID and what the chip shows. Never a local path. */
export type LauncherUpload = { id: string; name: string; size: number; mimeType?: string };
export function parseUpload(value: unknown): LauncherUpload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { id, name, size, mimeType } = value as Record<string, unknown>;
	if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || typeof name !== "string" || typeof size !== "number")
		return undefined;
	return {
		id,
		name: name.slice(0, 255),
		size,
		...(typeof mimeType === "string" ? { mimeType: mimeType.slice(0, 100) } : {}),
	};
}
export const formatSize = (bytes: number): string =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1048576
			? `${Math.round(bytes / 1024)} KB`
			: `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Answers to the launcher's grant-bound questions (section 3.1 rule 4, `externalEditor`): the text Ctrl+X copies, and
 * the editor text for Ctrl+G and its result. Only the mounted chat surface answers; the launcher drops results of a
 * grant that ended (navigation, swap).
 */
export function registerLauncherAnswers(surface: ChatSurface): () => void {
	const answers = surface.runtime.launcherAnswers;
	const own: [string, (payload: unknown) => unknown][] = [
		["copyText", () => ({ text: surface.lastAssistantText() ?? "" })],
		// Ctrl+V and p2.attach: the launcher uploaded a local file after its own confirmation.
		[
			"attached",
			(payload) => {
				const file = parseUpload(payload);
				return { added: file ? surface.addAttachment(file) : false };
			},
		],
		["editorText", () => (surface.editable ? { text: surface.editor.getExpandedText() } : null)],
		[
			"editorResult",
			(payload) => {
				const text =
					payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string"
						? payload.text
						: undefined;
				if (text === undefined || !surface.editable) return { applied: false };
				surface.editor.setText(text);
				surface.runtime.changed();
				return { applied: true };
			},
		],
	];
	for (const [kind, answer] of own) answers.set(kind, answer);
	return () => {
		for (const [kind, answer] of own) if (answers.get(kind) === answer) answers.delete(kind);
	};
}
