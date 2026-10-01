/**
 * pi-plus-cd: /cd command — move the session to a different working directory.
 *
 * pi binds a session's cwd at runtime creation (tools, project settings,
 * trust, system prompt, extensions), so an in-place flip is not possible.
 * The supported path is session replacement: /cd relocates the current
 * session file to the target directory's default session dir, rewriting
 * only the header's `cwd` field (id/timestamp/entries untouched, so it is
 * the same conversation), then switches to it. The old session file is
 * removed after the switch completes — the session has moved, not forked.
 *
 *   /cd           show the current working directory
 *   /cd <dir>     move the session to <dir> (relative to the current cwd, ~ expanded)
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import {
	CURRENT_SESSION_VERSION,
	getDefaultSessionDir,
	type SessionHeader,
} from "../../../../coding-agent/src/core/session-manager.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";

function readHeader(line: string): SessionHeader {
	const parsed = JSON.parse(line) as Partial<SessionHeader>;
	if (parsed.type !== "session" || typeof parsed.id !== "string" || typeof parsed.timestamp !== "string") {
		throw new Error("invalid session header");
	}
	return parsed as SessionHeader;
}

/** Header-only session for a session that has not been persisted to a file yet. */
function freshHeader(cwd: string): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd,
	};
}

/**
 * Write the relocated session file into the target cwd's default session dir.
 * Reuses the original filename (timestamp_id.jsonl) so the session keeps its
 * identity; regenerates the filename on collision.
 */
function writeRelocatedSession(sessionDir: string, header: SessionHeader, rest: string): string {
	const stamp = (iso: string) => iso.replace(/[:.]/g, "-");
	let fileName = `${stamp(header.timestamp)}_${header.id}.jsonl`;
	if (existsSync(join(sessionDir, fileName))) {
		fileName = `${stamp(new Date().toISOString())}_${header.id}.jsonl`;
	}
	const newPath = join(sessionDir, fileName);
	writeFileSync(newPath, `${JSON.stringify(header)}${rest}`);
	return newPath;
}

async function changeDirectory(ctx: ExtensionCommandContext, arg: string): Promise<void> {
	const currentCwd = resolvePath(ctx.cwd);
	const target = resolvePath(arg, currentCwd);

	if (target === currentCwd) {
		ctx.ui.notify(`Already in ${target}`, "info");
		return;
	}

	let isDirectory = false;
	try {
		isDirectory = statSync(target).isDirectory();
	} catch {
		// Missing target — reported below.
	}
	if (!isDirectory) {
		ctx.ui.notify(`Not a directory: ${arg} (resolved to ${target})`, "warning");
		return;
	}

	// The agent is idle when commands run, but settle any in-flight work so
	// the JSONL on disk is complete before we copy it.
	await ctx.waitForIdle();

	const currentFile = ctx.sessionManager.getSessionFile();
	let header: SessionHeader;
	let rest = "";
	if (currentFile && existsSync(currentFile)) {
		const content = readFileSync(currentFile, "utf8");
		const firstNewline = content.indexOf("\n");
		const headerLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
		rest = firstNewline === -1 ? "" : content.slice(firstNewline);
		try {
			header = { ...readHeader(headerLine), cwd: target };
		} catch {
			ctx.ui.notify(`Session file has an invalid header: ${currentFile}`, "error");
			return;
		}
	} else {
		// Session not persisted yet (no messages): start it directly in the
		// target directory instead.
		header = freshHeader(target);
	}

	const sessionDir = getDefaultSessionDir(target);
	const newPath = writeRelocatedSession(sessionDir, header, rest);

	const result = await ctx.switchSession(newPath, {
		withSession: async (fresh) => {
			// The switch completed: the copy is now the live session, so the
			// old file can go. A failed unlink leaves a stale duplicate —
			// warn rather than silently ignore.
			if (currentFile && existsSync(currentFile)) {
				try {
					unlinkSync(currentFile);
				} catch (error) {
					fresh.ui.notify(
						`Working directory: ${target} (could not remove old session file ${currentFile}: ${error instanceof Error ? error.message : String(error)})`,
						"warning",
					);
					return;
				}
			}
			fresh.ui.notify(`Working directory: ${target}`, "info");
		},
	});
	if (result.cancelled) {
		ctx.ui.notify(`Switch cancelled — session copy kept at ${newPath}.`, "warning");
	}
}

export function registerCd(pi: ExtensionAPI): void {
	pi.registerCommand("cd", {
		description: "Move the session to a different working directory",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				ctx.ui.notify(`cwd: ${ctx.cwd} — usage: /cd <dir>`, "info");
				return;
			}
			await changeDirectory(ctx, arg);
		},
	});
}
