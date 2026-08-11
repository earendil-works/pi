/**
 * Intercom message store: types, JSON serialize/parse, atomic write, channel scans.
 *
 * Messages live in `<cwd>/.pi/intercom/<channel>/`, one JSON file per message, so two
 * sessions writing concurrently can never interleave bytes. Filenames are
 * timestamp-prefixed, so lexicographic order is delivery order and a plain string
 * cursor ("last filename seen") is all a reader needs to resume.
 *
 * Pure + `node:fs` only. No pi imports, so this module is trivially unit-testable.
 * The clock is always passed in (`created`), never read here.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const INTERCOM_SCHEMA = "pi-intercom/v1";

export interface IntercomMessage {
	schema: string;
	channel: string;
	/** Full session id of the writer. Readers filter their own messages out by this. */
	sender: string;
	/** Human-friendly name the sender joined as, e.g. "laptop-player". */
	alias?: string;
	/** ISO 8601 timestamp. */
	created: string;
	text: string;
}

/**
 * Channel names become directory names, so the alphabet is deliberately tight: no
 * separators, no dots, nothing a path could smuggle. Case-insensitive match, but
 * callers should lowercase before writing so two spellings never split one channel.
 */
export function isValidChannel(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);
}

export function intercomDir(cwd: string): string {
	return join(cwd, ".pi", "intercom");
}

export function channelDir(cwd: string, channel: string): string {
	return join(intercomDir(cwd), channel);
}

/**
 * Mirror the handoff extension's note naming: sanitized ISO timestamp, then the first
 * 8 chars of the sender's session id. The zero-padded per-process sequence keeps two
 * same-millisecond messages from one sender in send order; cross-sender same-ms order
 * is arbitrary, which chat can tolerate.
 */
export function messageFilename(created: string, sender: string, seq: number): string {
	return `${created.replace(/[:.]/g, "-")}_${sender.slice(0, 8)}_${String(seq).padStart(4, "0")}.json`;
}

/** Write via `<name>.tmp` + rename, so no reader ever sees a half-written message. */
function writeFileAtomic(filePath: string, contents: string): void {
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

/** Write a message into its channel directory. Returns the message's path. */
export function writeMessage(cwd: string, message: IntercomMessage, seq: number): string {
	const dir = channelDir(cwd, message.channel);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, messageFilename(message.created, message.sender, seq));
	writeFileAtomic(filePath, `${JSON.stringify(message, null, "\t")}\n`);
	try {
		ensureGitExclude(cwd);
	} catch {
		// Git hygiene is a convenience; never fail a message write over it.
	}
	return filePath;
}

/**
 * Parse a message file's contents. Returns undefined when the JSON is malformed or
 * fails schema validation — callers skip such files and leave them in place.
 */
export function parseMessage(text: string): IntercomMessage | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const fields = raw as Record<string, unknown>;
	if (fields.schema !== INTERCOM_SCHEMA) return undefined;
	if (typeof fields.channel !== "string" || !isValidChannel(fields.channel)) return undefined;
	if (typeof fields.sender !== "string" || fields.sender.length === 0) return undefined;
	if (typeof fields.created !== "string" || fields.created.length === 0) return undefined;
	if (typeof fields.text !== "string") return undefined;

	const message: IntercomMessage = {
		schema: fields.schema,
		channel: fields.channel,
		sender: fields.sender,
		created: fields.created,
		text: fields.text,
	};
	if (typeof fields.alias === "string" && fields.alias.length > 0) message.alias = fields.alias;
	return message;
}

/** Message filenames in a channel, sorted (= chronological). `.tmp` scratch is excluded. */
export function listMessageFiles(cwd: string, channel: string): string[] {
	const dir = channelDir(cwd, channel);
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	names.sort();
	return names;
}

export interface Collected {
	/** New messages from senders other than `excludeSender`, oldest first. */
	messages: IntercomMessage[];
	/**
	 * New cursor: the greatest filename scanned, whether or not it was returned — own
	 * messages and corrupt files advance it too, so they are never rescanned forever.
	 * Equal to `afterName` when nothing new existed.
	 */
	cursor: string | undefined;
}

/**
 * Everything newer than the cursor, minus the reader's own messages.
 *
 * `afterName === undefined` means "from the beginning": a fresh join deliberately
 * receives the channel's full backlog, so a question sent before its answerer joined
 * is still delivered.
 */
export function collectNew(cwd: string, channel: string, afterName: string | undefined, excludeSender: string): Collected {
	const names = listMessageFiles(cwd, channel);
	const fresh = afterName === undefined ? names : names.filter((name) => name > afterName);

	const messages: IntercomMessage[] = [];
	for (const name of fresh) {
		let message: IntercomMessage | undefined;
		try {
			message = parseMessage(readFileSync(join(channelDir(cwd, channel), name), "utf8"));
		} catch {
			// Unreadable file: skip. The cursor still moves past it below.
		}
		if (message && message.sender !== excludeSender) messages.push(message);
	}

	return { messages, cursor: fresh.length > 0 ? fresh[fresh.length - 1] : afterName };
}

/** Channels that currently exist on disk, sorted. */
export function listChannels(cwd: string): string[] {
	const dir = intercomDir(cwd);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * Delete a channel's messages and its directory. Returns the number of message files
 * removed. Unknown files are left alone (and the directory kept) rather than deleted.
 */
export function clearChannel(cwd: string, channel: string): number {
	const dir = channelDir(cwd, channel);
	if (!existsSync(dir)) return 0;
	let removed = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
		try {
			unlinkSync(join(dir, name));
			removed++;
		} catch {
			// A vanished file was someone else clearing concurrently; keep going.
		}
	}
	try {
		rmdirSync(dir);
	} catch {
		// Non-empty (unknown files) or already gone — either way, not this call's problem.
	}
	return removed;
}

// Git-exclude hygiene below mirrors the handoff extension's `notes.ts` byte-for-byte in
// approach, with this extension's own entry. Duplicated rather than imported: extensions
// are self-contained units, and reaching into a sibling extension's module graph would
// couple this one's load to the other's presence. See DESIGN.md.

// Only `.pi/intercom/` is excluded — never all of `.pi/`, which some repos track.
// The leading double-star covers every cwd in the repo, not just the repo root.
const EXCLUDE_ENTRY = "**/.pi/intercom/";
const EXCLUDE_COMMENT = "# pi intercom messages (local only)";

function isIntercomExcludeLine(line: string): boolean {
	return line.trim().replace(/\/$/, "") === "**/.pi/intercom";
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
 * Keep intercom traffic out of git status without touching the project's tracked
 * `.gitignore` — `.git/info/exclude` is local-only and never committed. Idempotent,
 * and a no-op outside a git repo.
 */
export function ensureGitExclude(cwd: string): void {
	const gitDir = findGitDir(cwd);
	if (!gitDir) return;

	const excludePath = join(gitDir, "info", "exclude");
	const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	if (current.split("\n").some(isIntercomExcludeLine)) return;

	mkdirSync(join(gitDir, "info"), { recursive: true });
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	appendFileSync(excludePath, `${separator}${EXCLUDE_COMMENT}\n${EXCLUDE_ENTRY}\n`);
}
