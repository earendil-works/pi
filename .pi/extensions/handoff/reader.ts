/**
 * Reader: detect a pending handoff note, inject it as a first-message briefing,
 * archive it once it is actually delivered.
 *
 * The split between detection and archival matters. `session_start` only queues the
 * memo; if the session is opened and quit without a prompt, the note stays pending for
 * the next session instead of being consumed by a start nobody used.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { archiveNote, type HandoffNote, listPendingNotePaths, readNote } from "./notes.ts";

export interface PendingScan {
	/** Newest valid pending note — the one that gets injected. */
	ingest?: { path: string; note: HandoffNote };
	/** Older valid pending notes, oldest first. Archived as superseded on delivery. */
	older: string[];
	/** Notes whose frontmatter failed to parse. Never ingested, never archived. */
	corrupt: string[];
}

export function scanPendingNotes(cwd: string): PendingScan {
	const scan: PendingScan = { older: [], corrupt: [] };
	const valid: { path: string; note: HandoffNote }[] = [];

	for (const path of listPendingNotePaths(cwd)) {
		const note = readNote(path);
		if (note) valid.push({ path, note });
		else scan.corrupt.push(path);
	}

	// Filenames are timestamp-prefixed, so the list is already oldest-first.
	scan.ingest = valid.pop();
	scan.older = valid.map((entry) => entry.path);
	return scan;
}

export function buildMemo(note: HandoffNote, olderPendingCount = 0): string {
	const lines = [
		`Handoff from session ${note.frontmatter.session_id.slice(0, 8)}, ended ${note.frontmatter.created}` +
			` (${note.frontmatter.source === "command" ? "composed via /handoff" : "shutdown digest"}).`,
		"",
		note.body.trimEnd(),
	];
	if (note.frontmatter.session_file) {
		lines.push("", `Full transcript of that session: ${note.frontmatter.session_file}`);
	}
	if (olderPendingCount > 0) {
		const plural = olderPendingCount === 1 ? "note was" : "notes were";
		lines.push(
			"",
			`${olderPendingCount} older pending handoff ${plural} superseded by this one and moved to .pi/handoffs/archive/.`,
		);
	}
	return lines.join("\n");
}

/**
 * Archive the notes observed at detection time — deliberately not a fresh scan. A note
 * written after we started belongs to some other session's handoff; stamping it
 * superseded here would swallow a briefing nobody ever read.
 */
export function archiveDelivered(cwd: string, scan: PendingScan, consumerSessionId: string, consumedAt: string): void {
	if (!scan.ingest) return;
	archiveNote(cwd, scan.ingest.path, { consumed_by: consumerSessionId, consumed_at: consumedAt });
	const supersededBy = basename(scan.ingest.path);
	for (const path of scan.older) {
		archiveNote(cwd, path, { superseded_by: supersededBy });
	}
}

function warn(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	// Headless modes have no notification surface; stderr keeps `-p` stdout clean.
	else console.error(message);
}

export function registerReader(pi: ExtensionAPI): void {
	let pending: PendingScan | undefined;
	let delivered = false;

	pi.on("session_start", (event, ctx) => {
		// resume/fork sessions carry their own live context; another session's briefing
		// on top of it invites confusion.
		if (event.reason !== "startup" && event.reason !== "new") return;

		try {
			const scan = scanPendingNotes(ctx.cwd);
			for (const path of scan.corrupt) {
				warn(ctx, `Handoff note could not be parsed, left in place: ${path}`);
			}
			if (!scan.ingest) return;

			pending = scan;
			pi.sendMessage(
				{ customType: "handoff", content: buildMemo(scan.ingest.note, scan.older.length), display: true },
				// nextTurn parks the memo until the first real prompt, so an idle session
				// burns no LLM call and the memo lands whether that prompt comes from a
				// human, `pi -p`, RPC, or a future autonomous spawner.
				{ deliverAs: "nextTurn" },
			);
		} catch (err) {
			warn(ctx, `Handoff detection failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!pending || delivered) return;
		delivered = true;
		const scan = pending;
		pending = undefined;

		try {
			archiveDelivered(ctx.cwd, scan, ctx.sessionManager.getSessionId(), new Date().toISOString());
		} catch (err) {
			warn(ctx, `Handoff archive failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}
