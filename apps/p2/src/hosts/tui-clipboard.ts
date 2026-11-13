// Launcher-only clipboard writer, copied from coding-agent utils/clipboard.ts (copyToClipboard), clipboard-command.ts
// and wsl.ts. OSC 52 is written by the launcher itself (the worker's OSC is always filtered). Only called under a
// grant (p2-tui-port.md section 3.1 rules 4-5).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

/** Undefined means the command failed; an empty buffer is a successful result. */
function runClipboardCommand(
	command: string,
	args: readonly string[],
	options?: { input?: string; timeoutMs?: number },
): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		// Clipboard writers can daemonize. Do not give them output pipes to retain.
		const child = spawn(command, args, {
			stdio: ["pipe", options?.input === undefined ? "pipe" : "ignore", "ignore"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (result: Buffer | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, options?.timeoutMs ?? 3000);
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : undefined));
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stdin?.on("error", () => {});
		child.stdin?.end(options?.input);
	});
}

function isWSL(env: NodeJS.ProcessEnv): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}

async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	const tmpFile = join(tmpdir(), `p2-wsl-clip-${randomUUID()}.txt`);
	try {
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		const winPath = (await runClipboardCommand("wslpath", ["-w", tmpFile], { timeoutMs: 1000 }))
			?.toString("utf8")
			.trim();
		if (!winPath) return false;
		const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`;
		return (
			(await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 5000 })) !==
			undefined
		);
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
	}
}

/** Writes text to the visitor's clipboard: native, platform tools, then OSC 52 through `writeTerminal`. */
export async function copyToClipboard(
	text: string,
	writeTerminal: (data: string) => void,
	env: NodeJS.ProcessEnv = process.env,
	platform: string = osPlatform(),
): Promise<void> {
	const osc52 = (): boolean => {
		const encoded = Buffer.from(text).toString("base64");
		if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
		writeTerminal(`\x1b]52;c;${encoded}\x07`);
		return true;
	};
	let copied = false;
	if (platform !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			if (clipboard?.setText) {
				await clipboard.setText(text);
				copied = true;
			}
		} catch {}
	}
	if (!copied) {
		const commands: [string, string[]][] = [];
		if (platform === "darwin") commands.push(["pbcopy", []]);
		else if (platform === "win32") commands.push(["clip", []]);
		else {
			if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
			if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
			if (env.DISPLAY) commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
		}
		for (const [command, args] of commands) {
			if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
				copied = true;
				break;
			}
		}
	}
	let osc52Emitted = false;
	if (!copied && platform === "linux" && isWSL(env)) {
		if (env.WT_SESSION) osc52Emitted = osc52();
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}
	// OSC 52 cannot be verified: a desktop session with a display reports the failure instead; headless and remote
	// sessions use the terminal's clipboard.
	const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
	const headless = platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	if (!osc52Emitted && (remote || (!copied && headless))) {
		if (osc52()) copied = true;
		else if (!copied) throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	}
	if (!copied) throw new Error("Clipboard unavailable (install wl-copy, xclip or xsel)");
}

/** Copied from coding-agent utils/open-browser.ts: the platform opener with argv, never a shell. */
export function openBrowser(target: string, platform: string = osPlatform()): void {
	const [command, args]: [string, string[]] =
		platform === "darwin"
			? ["open", [target]]
			: platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];
	spawn(command, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}

/** Copied from coding-agent utils/clipboard.ts `readClipboardText`: platform tools, then the native clipboard. */
export async function readClipboardText(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = osPlatform(),
): Promise<string | null> {
	const commands: [string, string[]][] = [];
	if (env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	if (platform === "linux") {
		if (env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (env.DISPLAY)
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
	}
	for (const [command, args] of commands) {
		const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
		if (bytes !== undefined) return bytes.toString("utf8") || null;
	}
	try {
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

/** Copied from coding-agent `readClipboardFilePaths` (Finder file copies). */
export async function readClipboardFilePaths(): Promise<string[] | null> {
	try {
		const paths = await getNativeClipboard()?.getFilePaths?.();
		return paths?.length ? paths : null;
	} catch {
		return null;
	}
}

export type ClipboardImage = { bytes: Uint8Array; mimeType: string };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const baseMime = (mime: string) => mime.split(";")[0]?.trim().toLowerCase() ?? mime.toLowerCase();
const preferredImage = (types: string[]): string | undefined => {
	const list = types.map((type) => type.trim()).filter(Boolean);
	for (const preferred of IMAGE_TYPES) {
		const match = list.find((type) => baseMime(type) === preferred);
		if (match) return match;
	}
	return undefined;
};
/** Copied from coding-agent utils/mime.ts `detectSupportedImageMimeType` (the formats p2 accepts). */
export function sniffImage(bytes: Uint8Array): string | undefined {
	const ascii = (offset: number, text: string) =>
		[...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte))
		return "image/png";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	return undefined;
}

/**
 * Copied from coding-agent utils/clipboard-image.ts `readClipboardImage` without Photon conversion (unsupported formats
 * are not images here): wl-paste, xclip, WSL's PowerShell is left out, then the native clipboard.
 */
export async function readClipboardImage(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = osPlatform(),
): Promise<ClipboardImage | null> {
	if (env.TERMUX_VERSION) return null;
	const via = async (list: [string, string[]], read: (type: string) => [string, string[]]) => {
		const types = await runClipboardCommand(list[0], list[1], { timeoutMs: 1000 });
		if (types === undefined) return undefined;
		const type = preferredImage(types.toString("utf8").split(/\r?\n/));
		if (!type) return null;
		const [command, args] = read(type);
		const data = await runClipboardCommand(command, args, { timeoutMs: 5000 });
		if (data === undefined) return undefined;
		return data.length ? { bytes: new Uint8Array(data), mimeType: baseMime(type) } : null;
	};
	let image: ClipboardImage | null | undefined;
	if (platform === "linux") {
		if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland")
			image = await via(["wl-paste", ["--list-types"]], (type) => ["wl-paste", ["--type", type, "--no-newline"]]);
		if (image === undefined)
			image = await via(["xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]], (type) => [
				"xclip",
				["-selection", "clipboard", "-t", type, "-o"],
			]);
	}
	if (image === undefined) {
		try {
			const bytes = await getNativeClipboard()?.getImage();
			image = bytes?.length ? { bytes, mimeType: sniffImage(bytes) ?? "application/octet-stream" } : null;
		} catch {
			image = null;
		}
	}
	return image && IMAGE_TYPES.some((type) => type === image.mimeType) ? image : null;
}
