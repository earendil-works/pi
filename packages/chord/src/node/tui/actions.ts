// The launcher's actions (slice 11 §4; fix rounds 1 to 4: Fable's H1, H2, M1, L4, L6 and Opus's M1, M3, L2, L3, E5,
// E6, E9, E12, R1): what the sandbox may ask of the machine, each confirmed by the user on the launcher's own prompt
// before it touches it. Every line the prompt shows is wrapped to the terminal's width, never cut. Copying writes the
// text to the terminal's clipboard (OSC 52, which the output filter refuses to sandboxed code) and shows it first (up
// to five rows, then how many more characters); text with control characters (a newline and a tab aside) or
// bidirectional controls is refused. Opening a URL (http or https, no user info) names its host first and runs the
// platform's opener without a shell (as the coding agent's `open-browser.ts`). Attaching refuses a path with control,
// format or unusual whitespace characters (and on Windows UNC and device paths), shows the path resolved by its text
// (its name on its own line) without looking at the machine, after the user's yes resolves its links and asks again
// when they lead elsewhere, and reads the very file confirmed (its device and inode), a regular file of at most 16 MiB,
// exactly at the size its open handle has.

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { BridgeRequest } from "../../tui/bridge.ts";

/**
 * The launcher's prompt on the real terminal, `columns` wide: `ask` shows `lines` (the question last) and resolves
 * with the user's answer, yes or no; `write` writes to the terminal past the output filter (the launcher's own
 * sequences).
 */
export type PromptTerminal = {
	readonly columns: number;
	ask(lines: readonly string[]): Promise<boolean>;
	write(data: string): void;
};

/** The prompt's rows for `lines` at `columns` wide: control characters removed, each line wrapped, never cut. */
export function promptLines(lines: readonly string[], columns: number): string[] {
	return lines.flatMap((line) => wrap(line, promptWidth(columns)));
}

/** The text width of a prompt row (one column of padding each side). */
function promptWidth(columns: number): number {
	return Math.max(10, columns - 2);
}

/**
 * `line` with control characters removed, in rows of at most `width` columns, counting every character but printable
 * ASCII as two (wide characters never push text past the edge, where the next row would cover it).
 */
export function wrap(line: string, width: number): string[] {
	const rows: string[] = [];
	let row = "";
	let used = 0;
	for (const character of visible(line)) {
		const cells = character >= " " && character <= "~" ? 1 : 2;
		if (used + cells > width) {
			rows.push(row);
			row = "";
			used = 0;
		}
		row += character;
		used += cells;
	}
	rows.push(row);
	return rows;
}

/** How many rows of a copied text the prompt shows before "and N more characters". */
const SHOWN_ROWS = 5;

/**
 * Does the sandbox's `request` (`copy`, `open`) once the user confirmed it: whether it was done. Throws (the request
 * refused) for text it will not copy and URLs it will not open. `opener` opens a URL (the platform's by default).
 */
export async function act(
	request: Extract<BridgeRequest, { kind: "copy" | "open" }>,
	terminal: PromptTerminal,
	opener: (url: string) => Promise<void> = platformOpener,
): Promise<boolean> {
	if (request.kind === "copy") {
		const { text } = request;
		// Control characters (but newlines and tabs) and bidirectional controls could hide what a paste runs.
		if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)) {
			throw new Error("copy: the text holds control characters");
		}
		const lines = text.split("\n");
		// Wrapped, never cut: a long line's end is where a pasted command would hide (Opus E6).
		const rows = lines.flatMap((line) => wrap(line, promptWidth(terminal.columns) - 2));
		const hidden = rows.slice(SHOWN_ROWS).reduce((sum, row) => sum + row.length, 0);
		const question = `Copy these ${text.length} characters (${lines.length} line${lines.length === 1 ? "" : "s"})? [y/N]`;
		const shown = [
			...rows.slice(0, SHOWN_ROWS).map((row) => `  ${row}`),
			...(hidden > 0 ? [`  … and ${hidden} more characters`] : []),
		];
		if (!(await terminal.ask([...shown, question]))) return false;
		terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		return true;
	}
	const url = openable(request.url);
	if (url === undefined) throw new Error("open: only http and https URLs without user info open");
	if (!(await terminal.ask([`  ${url.href}`, `Open ${url.host} in the browser? [y/N]`]))) return false;
	await opener(url.href);
	return true;
}

/** The largest file the sandbox may be given: 16 MiB. */
export const MAX_ATTACHMENT = 16 * 1024 * 1024;

/**
 * Reads the file at `path` (as the sandbox gave it; `~/` the home directory) for the sandbox once the user confirmed
 * it: its name and bytes, or `null` when declined. Refused at once: a path with control, format or unusual whitespace
 * characters, and on Windows a UNC, device or `//host` path or a reserved device name. Nothing on the machine is looked
 * at before the user's yes (Opus E9: on Windows a lookup of `\\host\share` alone sends the user's credentials): the
 * prompt shows the path resolved by its text (`~`, `.` and `..`); after the yes its links are resolved, and a path
 * that leads elsewhere is asked about again, showing where; what is opened must be the file confirmed (its device and
 * inode as when the last prompt was shown). Then it is opened without blocking (a FIFO waits for no
 * writer: Opus E12) and read only when it is a regular file of at most `MAX_ATTACHMENT` bytes; one refusal for anything
 * else (no hint what is there).
 */
export async function attach(
	path: string,
	terminal: PromptTerminal,
	platform: NodeJS.Platform = process.platform,
): Promise<{ readonly name: string; readonly bytes: Uint8Array } | null> {
	if (!attachable(path, platform)) throw cannotAttach();
	const paths = platform === "win32" ? win32 : posix;
	const home = /^~(?:$|[\\/])/.test(path) ? paths.join(homedir(), path.slice(1)) : path;
	const named = paths.resolve(home);
	if (!(await terminal.ask(fileLines(named, paths, "Attach this file? [y/N]")))) return null;
	const file = await realpath(named).catch(() => undefined);
	if (file === undefined) throw cannotAttach();
	// The file the user confirms, by identity: what is read must be it (Opus R1: a parent directory swapped for a link
	// after the yes would lead elsewhere, past `O_NOFOLLOW`, which guards the last step only).
	const shown = await stat(file, { bigint: true }).catch(() => undefined);
	if (shown === undefined) throw cannotAttach();
	if (file !== named && !(await terminal.ask(fileLines(file, paths, "It links here. Attach this file? [y/N]")))) {
		return null;
	}
	// No waiting on a FIFO or device, and no link swapped in at the last step since the user saw the path.
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(file, flags).catch(() => undefined);
	if (handle === undefined) throw cannotAttach();
	try {
		const info = await handle.stat({ bigint: true });
		if (info.dev !== shown.dev || info.ino !== shown.ino) throw cannotAttach();
		if (!info.isFile() || info.size > BigInt(MAX_ATTACHMENT)) throw cannotAttach();
		// Exactly its size now: a file growing meanwhile is read up to what was checked.
		const bytes = new Uint8Array(Number(info.size));
		let read = 0;
		while (read < bytes.length) {
			const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return { name: paths.basename(file), bytes: bytes.subarray(0, read) };
	} finally {
		await handle.close();
	}
}

/**
 * Whether `path` may be shown and, once confirmed, opened on `platform`: no character that hides or moves what the
 * prompt shows (controls, format characters such as bidirectional and zero-width ones, whitespace but single spaces
 * between words: Opus E5), and on Windows no UNC, device or `//host` path and no reserved device name (Opus E9).
 */
function attachable(path: string, platform: NodeJS.Platform): boolean {
	if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S ]| {2}|^ | $/u.test(path)) return false;
	if (platform !== "win32") return true;
	if (/^[\\/]{2}/.test(path)) return false;
	return !path
		.split(/[\\/]/)
		.some((segment) => /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\..*)?$/i.test(segment));
}

/** The prompt's lines for the file at `file`: its name, its directory, then `question`. */
function fileLines(file: string, paths: typeof posix, question: string): string[] {
	return [`File: ${paths.basename(file)}`, `In:   ${paths.dirname(file)}`, question];
}

function cannotAttach(): Error {
	return new Error("attach: that file cannot be attached");
}

/** `text` with control and format characters (bidirectional, zero width) removed: sandboxed text in the prompt. */
function visible(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

/** `url` when it is an http or https URL without user info; else `undefined`. */
function openable(url: string): URL | undefined {
	try {
		const value = new URL(url);
		const web = value.protocol === "http:" || value.protocol === "https:";
		return web && value.username === "" && value.password === "" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The command and arguments opening `url` on `platform`, as the coding agent opens a browser (`open-browser.ts`): never
 * a shell (on Windows not `cmd /c start`, whose parsing runs what follows a `&`): `rundll32
 * url.dll,FileProtocolHandler <url>` on Windows, `open` on macOS, `xdg-open` elsewhere, the URL one argument.
 */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	return [platform === "darwin" ? "open" : "xdg-open", [url]];
}

/** Opens `url` with the platform's opener (`openerCommand`), detached, best effort: a missing opener is no crash. */
async function platformOpener(url: string): Promise<void> {
	const [command, args] = openerCommand(url);
	// The root as its directory: no opener needs the launcher's (a WSL path too long for explorer.exe, pi #11592).
	spawn(command, args, { stdio: "ignore", detached: true, cwd: "/", shell: false })
		.on("error", () => {})
		.unref();
}
