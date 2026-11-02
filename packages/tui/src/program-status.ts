/**
 * Program Status Protocol (OSC 7501): a program tells the terminal whether it is idle, working,
 * blocked on the user, done, or failed. Only the root record is supported.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 */

import { replaceControlCharacters } from "./utils.ts";

export interface ProgramStatus {
	/** `clear` removes the status instead of reporting one. */
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	/** Stable program name, `[A-Za-z0-9_.+-]{1,32}`. Other values are omitted. */
	app?: string;
	/** What a blocked program waits for. Omitted for other states. */
	kind?: "permission" | "question" | "auth";
	/** One human-readable line. Control characters become spaces; longer text is cut to the spec limit. */
	message?: string;
}

/** Feature detection query. A supporting terminal replies with the same body. */
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

/** The reply to {@link PROGRAM_STATUS_QUERY}. Later spec revisions may add pairs after the `?`. */
export function isProgramStatusReply(sequence: string): boolean {
	return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
/** Decoded `msg` limit. Its base64 encoding stays under the 2732-byte encoded limit. */
const MAX_MESSAGE_BYTES = 2048;

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/** Encode a status report. Terminals discard reports whose text contains control characters, so they are replaced. */
export function formatProgramStatus(status: ProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const message = truncateUtf8(replaceControlCharacters(status.message ?? "").trim(), MAX_MESSAGE_BYTES);
	if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
