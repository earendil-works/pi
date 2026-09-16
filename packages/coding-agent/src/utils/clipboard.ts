import { platform } from "node:os";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { runClipboardCommand } from "./clipboard-command.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * macOS `pbcopy` converts text using the locale's encoding, so a non-UTF-8
 * `LC_CTYPE` (a login shell with no `LANG`, or an explicit `C` locale) writes
 * non-ASCII text as MacRoman: `—` lands on the pasteboard as byte `0xD1` and
 * pastes back as `‚Äî`. The native writer is unaffected; this only matters when
 * `copyToClipboard` falls back to `pbcopy`.
 *
 * Returns the environment to use for that child process, or `undefined` when the
 * ambient locale is already UTF-8.
 */
export function clipboardCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
	const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
	if (/utf-?8/i.test(effective)) return undefined;
	return { ...env, LC_ALL: "en_US.UTF-8" };
}

/** Read plain text from the system clipboard. */
export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux") {
		const commands: [string, string[]][] = [];
		if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
		}
		for (const [command, args] of commands) {
			const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
			if (bytes !== undefined) return bytes.toString("utf8") || null;
		}
	}
	try {
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	let copied = false;
	// Direct writes precede OSC 52 so the terminal cannot race the native writer.
	// Linux tools retain clipboard selection ownership after this call returns.
	if (p !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			if (clipboard?.setText) {
				await clipboard.setText(text);
				copied = true;
			}
		} catch {
			// Try platform commands next.
		}
	}
	if (!copied) {
		const commands: [string, string[], NodeJS.ProcessEnv | undefined][] = [];
		// pbcopy converts through the locale encoding, so it needs a UTF-8 one to keep
		// non-ASCII intact. The other writers pass bytes through untouched.
		if (p === "darwin") commands.push(["pbcopy", [], clipboardCommandEnv()]);
		else if (p === "win32") commands.push(["clip", [], undefined]);
		else {
			if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-set", [], undefined]);
			if (process.env.WAYLAND_DISPLAY) commands.push(["wl-copy", [], undefined]);
			if (process.env.DISPLAY) {
				commands.push(
					["xclip", ["-selection", "clipboard"], undefined],
					["xsel", ["--clipboard", "--input"], undefined],
				);
			}
		}
		for (const [command, args, env] of commands) {
			if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000, env })) !== undefined) {
				copied = true;
				break;
			}
		}
	}
	if (isRemoteSession()) copied = emitOsc52(text) || copied;
	if (!copied) {
		if (p === "linux") {
			if (process.env.TERMUX_VERSION) {
				throw new Error("Clipboard unavailable: install the Termux:API app and `termux-api` package");
			}
			if (process.env.WAYLAND_DISPLAY) {
				throw new Error("Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access");
			}
			if (process.env.DISPLAY) {
				throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
			}
			throw new Error("Clipboard unavailable: no Wayland or X11 display detected");
		}
		throw new Error("Clipboard unavailable");
	}
}
