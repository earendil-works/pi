import { closeSync, existsSync, fsyncSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { APP_NAME } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { SessionHeader } from "./session-manager.ts";

export interface SessionCwdIssue {
	sessionFile?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}

const SESSION_CWD_COPY_BUFFER_SIZE = 1024 * 1024;

interface LocatedSessionHeader {
	header: SessionHeader;
	/** Byte offset where the header line starts. */
	start: number;
	/** Byte offset just past the header line, including its newline. */
	end: number;
}

function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	try {
		const entry = JSON.parse(line) as SessionHeader;
		if (entry.type !== "session" || typeof entry.id !== "string") return null;
		return entry;
	} catch {
		return undefined;
	}
}

/**
 * Locate the session header line, matching loadEntriesFromFile(): blank and malformed
 * leading lines are skipped and the first parseable entry must be the session header.
 */
function locateSessionHeader(fd: number): LocatedSessionHeader | null {
	const buffer = Buffer.allocUnsafe(SESSION_CWD_COPY_BUFFER_SIZE);
	const pending: Buffer[] = [];
	let lineStart = 0;
	let offset = 0;

	while (true) {
		const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
		if (bytesRead === 0) {
			if (pending.length === 0) return null;
			const header = parseSessionHeaderCandidate(Buffer.concat(pending).toString("utf8"));
			return header ? { header, start: lineStart, end: offset } : null;
		}

		let chunkLineStart = 0;
		for (let i = 0; i < bytesRead; i++) {
			if (buffer[i] !== 0x0a) continue;
			pending.push(Buffer.from(buffer.subarray(chunkLineStart, i)));
			const header = parseSessionHeaderCandidate(Buffer.concat(pending).toString("utf8"));
			pending.length = 0;
			if (header === null) return null;
			if (header) return { header, start: lineStart, end: offset + i + 1 };
			lineStart = offset + i + 1;
			chunkLineStart = i + 1;
		}
		if (chunkLineStart < bytesRead) {
			pending.push(Buffer.from(buffer.subarray(chunkLineStart, bytesRead)));
		}
		offset += bytesRead;
	}
}

function copyFileRange(srcFd: number, dstFd: number, start: number, end?: number): void {
	const buffer = Buffer.allocUnsafe(SESSION_CWD_COPY_BUFFER_SIZE);
	let position = start;
	while (end === undefined || position < end) {
		const length = end === undefined ? buffer.length : Math.min(buffer.length, end - position);
		const bytesRead = readSync(srcFd, buffer, 0, length, position);
		if (bytesRead === 0) break;
		writeSync(dstFd, buffer, 0, bytesRead);
		position += bytesRead;
	}
}

/**
 * Store a new working directory in a session file's header. Every other byte is kept
 * unchanged: the header line is replaced in a temporary copy that is then renamed over
 * the original, so a crash cannot leave a truncated session behind.
 */
export function updateSessionFileCwd(sessionFile: string, cwd: string): void {
	const resolvedFile = resolvePath(sessionFile);
	const tempFile = `${resolvedFile}.${process.pid}.tmp`;
	const srcFd = openSync(resolvedFile, "r");
	let renamed = false;
	try {
		const located = locateSessionHeader(srcFd);
		if (!located) {
			throw new Error(`Session file is not a valid ${APP_NAME} session: ${resolvedFile}`);
		}
		const headerLine = Buffer.from(`${JSON.stringify({ ...located.header, cwd })}\n`, "utf8");
		const tmpFd = openSync(tempFile, "w", statSync(resolvedFile).mode);
		try {
			copyFileRange(srcFd, tmpFd, 0, located.start);
			writeSync(tmpFd, headerLine, 0, headerLine.length);
			copyFileRange(srcFd, tmpFd, located.end);
			fsyncSync(tmpFd);
		} finally {
			closeSync(tmpFd);
		}
		renameSync(tempFile, resolvedFile);
		renamed = true;
	} finally {
		closeSync(srcFd);
		if (!renamed) rmSync(tempFile, { force: true });
	}
}
