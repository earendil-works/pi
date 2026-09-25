/**
 * Plan file location and path-matching helpers for plan mode.
 *
 * The plan file lives at <agentDir>/plans/<sessionId>.md (per-profile agent
 * dirs stay isolated, mirroring the tasks store layout). While plan mode is
 * active it is the ONLY file the model may edit; `isPlanFileTarget` is the
 * carve-out check used by the tool gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";

/** <agentDir>/plans — created lazily on first use. */
export function plansDir(): string {
	return path.join(getAgentDir(), "plans");
}

function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Absolute path of this session's plan file. Creates the plans dir. */
export function planFilePathFor(sessionId: string): string {
	const dir = plansDir();
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${sanitizeSessionId(sessionId)}.md`);
}

/** Plan file contents, or "" when it does not exist yet / cannot be read. */
export async function readPlan(filePath: string): Promise<string> {
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch {
		return "";
	}
}

/** Write plan file contents (user edits from the ExitPlanMode / /plan flows). */
export async function writePlan(filePath: string, content: string): Promise<void> {
	await fs.promises.writeFile(filePath, content, "utf-8");
}

/**
 * Canonicalize `filePath` through the nearest existing ancestor: walk up from
 * the file's parent realpath'ing the first existing directory, re-attaching
 * the not-yet-existing tail (the plan file and possibly its plans dir may not
 * exist yet). Falls back to the input path when nothing resolves.
 */
function realpathResolved(filePath: string): string {
	let dir = path.dirname(filePath);
	let tail = path.basename(filePath);
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(dir), tail);
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return filePath;
			tail = path.join(path.basename(dir), tail);
			dir = parent;
		}
	}
}

function normalizeForCompare(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * True when `rawPath` (a tool-supplied file path, relative to cwd or
 * absolute) refers to the session plan file. Compares resolved paths, then
 * realpath'd parent dirs so a symlinked agent dir (e.g. ~/.pi on a linked
 * volume) still matches. The plan file itself may not exist yet, so only
 * parents are realpath'd.
 */
export function isPlanFileTarget(cwd: string, rawPath: unknown, planFilePath: string): boolean {
	if (typeof rawPath !== "string" || rawPath.length === 0) return false;
	const resolved = path.resolve(cwd, rawPath);
	if (normalizeForCompare(resolved) === normalizeForCompare(planFilePath)) return true;
	return normalizeForCompare(realpathResolved(resolved)) === normalizeForCompare(realpathResolved(planFilePath));
}
