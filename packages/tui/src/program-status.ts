/**
 * Program Status Protocol (OSC 7501): a program tells the terminal whether it is idle, working,
 * blocked on the user, done, or failed. Only the root record is supported.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 */

export interface ProgramStatus {
	/** `clear` removes the status instead of reporting one. */
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	/** Stable program name, `[A-Za-z0-9_.+-]{1,32}`. Other values are omitted. */
	app?: string;
	/** What a blocked program waits for. Omitted for other states. */
	kind?: "permission" | "question" | "auth";
	/** Short human-readable label for the program. Control characters become spaces; longer text is cut to the spec limit. */
	title?: string;
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
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
/** Decoded `msg` limit. Its base64 encoding stays under the 2732-byte encoded limit. */
const MAX_MESSAGE_BYTES = 2048;
/** Decoded `title` limit. Its base64 encoding stays within the 256-byte encoded limit. */
const MAX_TITLE_BYTES = 192;

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

/** Replace control characters, cut to `maxBytes` decoded bytes, and base64-encode. Empty text yields "". */
function encodeText(text: string | undefined, maxBytes: number): string {
	const clean = truncateUtf8((text ?? "").replace(CONTROL_CHARACTERS, " ").trim(), maxBytes);
	return clean ? Buffer.from(clean, "utf8").toString("base64") : "";
}

/** Encode a status report. Terminals discard reports whose text contains control characters, so they are replaced. */
export function formatProgramStatus(status: ProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const title = encodeText(status.title, MAX_TITLE_BYTES);
	if (title) pairs.push(`title=${title}`);
	const message = encodeText(status.message, MAX_MESSAGE_BYTES);
	if (message) pairs.push(`msg=${message}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
