/**
 * Session Handoff extension.
 *
 * Every session leaves a durable handoff note in `<cwd>/.pi/handoffs/`, and new
 * sessions pick the newest pending note up as a first-message briefing. See DESIGN.md.
 *
 * Two writers:
 * - `/handoff [goal]` — rich, LLM-composed.
 * - `session_shutdown` on quit — mechanical digest, no LLM. The seatbelt.
 */

import type { Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type ComposeResult, composeNoteBody } from "./compose.ts";
import { buildDigestNote } from "./digest.ts";
import { HANDOFF_SCHEMA, type HandoffNote, writeNote } from "./notes.ts";
import { registerReader } from "./reader.ts";

export interface HandoffState {
	/** Set by `/handoff`. Suppresses the shutdown digest, which would supersede a richer note. */
	wroteNoteThisSession: boolean;
}

function modelLabel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/**
 * Report from the shutdown path, where `ctx.ui.notify` is not enough on its own.
 * Interactive quit stops the TUI *before* emitting `session_shutdown` — deliberately, so
 * extension teardown cannot repaint the final frame — so a notify there paints nothing.
 * A seatbelt that can fail silently is not a seatbelt, so failures also go to stderr,
 * which pi itself proves still works at that point (it writes the resume hint right after).
 */
function reportFromShutdown(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	if (level === "warning") console.error(message);
}

function registerShutdownDigest(pi: ExtensionAPI, state: HandoffState): void {
	pi.on("session_shutdown", (event, ctx) => {
		// The event also fires for reload/new/resume/fork, which must not each drop a note.
		if (event.reason !== "quit") return;
		if (state.wroteNoteThisSession) return;

		// Undefined for `--no-session` runs: the user asked not to be recorded, so honor it.
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		try {
			const note = buildDigestNote({
				entries: ctx.sessionManager.getEntries(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile,
				cwd: ctx.cwd,
				model: modelLabel(ctx),
				created: new Date().toISOString(),
			});
			if (!note) return;

			const notePath = writeNote(ctx.cwd, note);
			reportFromShutdown(ctx, `Handoff note written: ${notePath}`, "info");
		} catch (err) {
			// Never let a note failure interfere with pi's exit.
			reportFromShutdown(ctx, `Handoff note failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	});
}

/** Render the compaction-aware branch as the plain text the composer reads. */
function serializeBranch(entries: SessionEntry[]): string {
	return serializeConversation(convertToLlm(entries.flatMap(sessionEntryToContextMessages)));
}

/**
 * Run the composition call, showing a cancellable loader in the TUI. Other modes just
 * await it: they have no component surface, and `-p`/RPC callers are not watching.
 */
async function compose(
	ctx: ExtensionCommandContext,
	model: Model<any>,
	conversationText: string,
	goal: string,
): Promise<ComposeResult> {
	const run = (signal?: AbortSignal) =>
		composeNoteBody({
			modelRegistry: ctx.modelRegistry,
			model,
			conversationText,
			goal,
			signal,
			sessionId: uuidv7(),
		});

	if (ctx.mode !== "tui") return run();

	return ctx.ui.custom<ComposeResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Composing handoff note...");
		loader.onAbort = () => done({ status: "aborted" });
		run(loader.signal)
			.then(done)
			// composeNoteBody reports provider failures through its result rather than by
			// throwing, so this catches only an unexpected throw from the call itself.
			.catch((err) => done({ status: "failed", message: err instanceof Error ? err.message : String(err) }));
		return loader;
	});
}

function registerHandoffCommand(pi: ExtensionAPI, state: HandoffState): void {
	pi.registerCommand("handoff", {
		description: "Write a handoff note for the next session",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// buildContextEntries is compaction-aware; a hand-rolled branch walk would
			// duplicate that logic and drift from it.
			const entries = ctx.sessionManager.buildContextEntries();
			const conversationText = serializeBranch(entries);
			if (!conversationText.trim()) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const goal = args.trim();
			const composed = await compose(ctx, model, conversationText, goal);
			if (composed.status === "failed") {
				ctx.ui.notify(`Handoff composition failed: ${composed.message}`, "error");
				return;
			}
			if (composed.status === "aborted") {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}

			// Review is skipped where there is no dialog surface, rather than failing:
			// automation is the point of this extension.
			let body = composed.body;
			if (ctx.hasUI) {
				const edited = await ctx.ui.editor("Edit handoff note", body);
				if (edited === undefined) {
					ctx.ui.notify("Handoff cancelled", "info");
					return;
				}
				body = edited;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			const note: HandoffNote = {
				frontmatter: {
					schema: HANDOFF_SCHEMA,
					session_id: ctx.sessionManager.getSessionId(),
					session_file: sessionFile,
					cwd: ctx.cwd,
					created: new Date().toISOString(),
					source: "command",
					model: modelLabel(ctx),
					kickoff: composed.kickoff || goal || "Continue the previous session's work.",
				},
				body,
			};

			let notePath: string;
			try {
				notePath = writeNote(ctx.cwd, note);
			} catch (err) {
				ctx.ui.notify(`Handoff note failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			state.wroteNoteThisSession = true;
			ctx.ui.notify(`Handoff note written: ${notePath}`, "info");

			if (ctx.mode !== "tui") return;
			if (!(await ctx.ui.confirm("Handoff", "Start successor session now?"))) return;

			// The successor's own session_start picks the note back up through the reader.
			// All post-switch work must use the replacement context: the ctx captured here
			// is invalidated once the session is replaced.
			const result = await ctx.newSession({
				parentSession: sessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("Handoff briefing queued for your first prompt.", "info");
				},
			});
			if (result.cancelled) ctx.ui.notify("New session cancelled", "info");
		},
	});
}

/** Sets the injected briefing apart from the user's own first prompt in the transcript. */
function registerMemoRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("handoff", (message, { outputPad }, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const [banner, ...rest] = text.split("\n");
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", banner)}\n${rest.join("\n")}`, 0, 0));
		return box;
	});
}

export default function (pi: ExtensionAPI) {
	const state: HandoffState = { wroteNoteThisSession: false };
	registerReader(pi);
	registerMemoRenderer(pi);
	registerHandoffCommand(pi, state);
	registerShutdownDigest(pi, state);
}
