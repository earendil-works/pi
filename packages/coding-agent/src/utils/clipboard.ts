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
		const commands: [string, string[]][] = [];
		if (p === "darwin") commands.push(["pbcopy", []]);
		else if (p === "win32") commands.push(["clip", []]);
		else {
			if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
			if (process.env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
			if (process.env.DISPLAY) {
				commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
			}
		}
		for (const [command, args] of commands) {
			if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
				copied = true;
				break;
			}
		}
	}
	if (isRemoteSession() || !copied) copied = emitOsc52(text) || copied;
	if (!copied) throw new Error("Failed to copy to clipboard");
}
