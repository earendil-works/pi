/**
 * Handoff note storage: types, frontmatter serialize/parse, atomic write, archive ops.
 *
 * Notes live in `<cwd>/.pi/handoffs/`. Pending vs consumed is encoded by location
 * (top level vs `archive/`), never by a status field, so a crash can never leave a
 * note in a half-consumed state.
 *
 * Pure + `node:fs` only. No pi imports, so this module is trivially unit-testable.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const HANDOFF_SCHEMA = "pi-handoff/v1";

export type HandoffSource = "command" | "digest";

export interface HandoffFrontmatter {
	schema: string;
	session_id: string;
	/** Absolute path to the writing session's JSONL. Absent for `--no-session` runs. */
	session_file?: string;
	cwd: string;
	/** ISO 8601 timestamp. */
	created: string;
	source: HandoffSource;
	model?: string;
	/** Ready-made opening prompt for a successor session. The v2 autonomous-spawner contract. */
	kickoff: string;
	/** Stamped on archive: session id that ingested this note. */
	consumed_by?: string;
	consumed_at?: string;
	/** Stamped on archive: filename of the note that superseded this one. */
	superseded_by?: string;
}

export interface HandoffNote {
	frontmatter: HandoffFrontmatter;
	body: string;
}

/** Frontmatter keys emitted in this order; anything else is appended alphabetically. */
const KEY_ORDER = [
	"schema",
	"session_id",
	"session_file",
	"cwd",
	"created",
	"source",
	"model",
	"kickoff",
	"consumed_by",
	"consumed_at",
	"superseded_by",
];

export function handoffsDir(cwd: string): string {
	return join(cwd, ".pi", "handoffs");
}

export function archiveDir(cwd: string): string {
	return join(handoffsDir(cwd), "archive");
}

/**
 * Mirror pi's session-file naming: ISO timestamp with `:`/`.` replaced by `-`, then
 * the first 8 chars of the writing session's id. Lexicographic sort = age sort.
 */
export function noteFilename(created: string, sessionId: string): string {
	return `${created.replace(/[:.]/g, "-")}_${sessionId.slice(0, 8)}.md`;
}

/**
 * Quote a frontmatter value only when a YAML plain scalar would be ambiguous.
 * Double-quoted YAML accepts JSON escaping, so `JSON.stringify` is a valid emitter.
 */
function serializeValue(value: string): string {
	const needsQuoting =
		value === "" ||
		value !== value.trim() ||
		/[\n\r\t"'#]/.test(value) ||
		/:\s/.test(value) ||
		value.endsWith(":") ||
		/^[-?:,[\]{}&*!|>%@`]/.test(value);
	return needsQuoting ? JSON.stringify(value) : value;
}

function parseValue(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === "string") return parsed;
		} catch {
			// Fall through to the raw value; a malformed quote is better surfaced as text
			// than as a dropped note.
		}
	}
	return trimmed;
}

export function serializeNote(note: HandoffNote): string {
	const entries = Object.entries(note.frontmatter).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
	);
	entries.sort(([a], [b]) => {
		const ai = KEY_ORDER.indexOf(a);
		const bi = KEY_ORDER.indexOf(b);
		if (ai === -1 && bi === -1) return a.localeCompare(b);
		if (ai === -1) return 1;
		if (bi === -1) return -1;
		return ai - bi;
	});

	const lines = entries.map(([key, value]) => `${key}: ${serializeValue(value)}`);
	const body = note.body.endsWith("\n") ? note.body : `${note.body}\n`;
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/**
 * Parse a note. Returns undefined when the frontmatter is missing, unterminated, or
 * fails schema validation — callers treat that as not-pending and leave the file alone.
 */
export function parseNote(text: string): HandoffNote | undefined {
	const normalized = text.startsWith("﻿") ? text.slice(1) : text;
	const lines = normalized.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;

	const closing = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (closing === -1) return undefined;

	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, closing)) {
		if (line.trim() === "") continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
		if (!match) return undefined;
		fields[match[1]] = parseValue(match[2]);
	}

	if (fields.schema !== HANDOFF_SCHEMA) return undefined;
	if (!fields.session_id || !fields.created) return undefined;
	if (fields.source !== "command" && fields.source !== "digest") return undefined;

	const frontmatter: HandoffFrontmatter = {
		schema: fields.schema,
		session_id: fields.session_id,
		cwd: fields.cwd ?? "",
		created: fields.created,
		source: fields.source,
		// A hand-edited note may drop kickoff. Default it rather than discard the briefing.
		kickoff: fields.kickoff ?? "",
	};
	if (fields.session_file) frontmatter.session_file = fields.session_file;
	if (fields.model) frontmatter.model = fields.model;
	if (fields.consumed_by) frontmatter.consumed_by = fields.consumed_by;
	if (fields.consumed_at) frontmatter.consumed_at = fields.consumed_at;
	if (fields.superseded_by) frontmatter.superseded_by = fields.superseded_by;

	return {
		frontmatter,
		body: lines
			.slice(closing + 1)
			.join("\n")
			.replace(/^\n+/, ""),
	};
}

/** Write via `<name>.tmp` + rename, so no reader ever sees a half-written note. */
export function writeFileAtomic(filePath: string, contents: string): void {
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, contents, "utf8");
	try {
		renameSync(tmp, filePath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort; the failed rename is the error worth reporting.
		}
		throw err;
	}
}

// Only `.pi/handoffs/` is excluded — never all of `.pi/`, which some repos track.
//
// The leading double-star is load-bearing. A gitignore pattern with a separator anywhere
// but the end is anchored to the ignore file's directory, which for `.git/info/exclude` is
// the repo root — so a bare `.pi/handoffs/` would miss notes written when pi runs from a
// subdirectory, which is where `<ctx.cwd>/.pi/handoffs/` puts them. One starred entry
// covers every cwd in the repo.
const EXCLUDE_ENTRY = "**/.pi/handoffs/";
const EXCLUDE_COMMENT = "# pi session handoff notes (local only)";

// Recognise only the starred form. A bare `.pi/handoffs/` line — what earlier runs of this
// code wrote — does not count as satisfying the entry, so a repo carrying the old broken
// pattern gets the working one appended rather than skipped. The stale line is a harmless
// subset of the new one.
function isHandoffExcludeLine(line: string): boolean {
	return line.trim().replace(/\/$/, "") === "**/.pi/handoffs";
}

/** Linked worktrees have their own git dir but share info/exclude via `commondir`. */
function resolveCommonGitDir(gitDir: string): string {
	const commonDirFile = join(gitDir, "commondir");
	if (!existsSync(commonDirFile)) return gitDir;
	try {
		const relative = readFileSync(commonDirFile, "utf8").trim();
		return relative ? resolve(gitDir, relative) : gitDir;
	} catch {
		return gitDir;
	}
}

/** Undefined when cwd is not inside a git repo. `.git` is a file in worktrees and submodules. */
function findGitDir(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			const stats = statSync(gitPath);
			if (stats.isDirectory()) return resolveCommonGitDir(gitPath);
			if (stats.isFile()) {
				const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"));
				return match ? resolveCommonGitDir(resolve(dir, match[1].trim())) : undefined;
			}
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Keep handoff notes out of git status without touching the project's tracked
 * `.gitignore` — `.git/info/exclude` is local-only and never committed. Idempotent, and
 * a no-op outside a git repo.
 */
export function ensureGitExclude(cwd: string): void {
	const gitDir = findGitDir(cwd);
	if (!gitDir) return;

	const excludePath = join(gitDir, "info", "exclude");
	const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	if (current.split("\n").some(isHandoffExcludeLine)) return;

	mkdirSync(join(gitDir, "info"), { recursive: true });
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	appendFileSync(excludePath, `${separator}${EXCLUDE_COMMENT}\n${EXCLUDE_ENTRY}\n`);
}

/** Write a pending note into `<cwd>/.pi/handoffs/`. Returns the note's path. */
export function writeNote(cwd: string, note: HandoffNote): string {
	const dir = handoffsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, noteFilename(note.frontmatter.created, note.frontmatter.session_id));
	writeFileAtomic(filePath, serializeNote(note));
	try {
		ensureGitExclude(cwd);
	} catch {
		// Git hygiene is a convenience; never fail a note write over it.
	}
	return filePath;
}

/** Pending note paths, oldest first. Archived notes and `.tmp` scratch files are excluded. */
export function listPendingNotePaths(cwd: string): string[] {
	const dir = handoffsDir(cwd);
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	names.sort();
	return names.map((name) => join(dir, name));
}

export function readNote(filePath: string): HandoffNote | undefined {
	try {
		return parseNote(readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Move a pending note into `archive/` and stamp it.
 *
 * The rename happens first and is the claim: when two sessions race, the loser's
 * rename fails ENOENT and this returns false. Both sessions ingesting the same
 * briefing is acceptable; losing it is not.
 *
 * Returns false when the note was already claimed or gone. A stamping failure after
 * a successful rename still returns true — the archive move is the part that matters.
 */
export function archiveNote(cwd: string, notePath: string, stamp: Partial<HandoffFrontmatter>): boolean {
	const dir = archiveDir(cwd);
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		return false;
	}

	const target = join(dir, basename(notePath));
	try {
		renameSync(notePath, target);
	} catch {
		return false;
	}

	try {
		const note = readNote(target);
		if (note) {
			writeFileAtomic(target, serializeNote({ frontmatter: { ...note.frontmatter, ...stamp }, body: note.body }));
		}
	} catch {
		// Archived but unstamped: audit metadata is lost, the note is not.
	}
	return true;
}
