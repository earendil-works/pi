import { execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.js";
import { clipboard } from "./clipboard-native.js";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	// Await the native addon to completion *before* emitting OSC 52. If OSC 52
	// is emitted first, the outer terminal (tmux with set-clipboard on, iTerm2,
	// Ghostty, etc.) may write NSPasteboard concurrently with the native
	// addon's tokio worker, which panics the addon on macOS with
	// `writeObjects failed` (kPasteboardSyncErr). Sequential is safe. OSC 52
	// still fires afterward so SSH/mosh sessions (where native writes the
	// wrong machine's clipboard) reach the user's real terminal.
	let nativeOk = false;
	try {
		if (clipboard) {
			await clipboard.setText(text);
			nativeOk = true;
		}
	} catch {
		// Native failed. Fall through to OSC 52 + platform-specific tools.
	}

	const encoded = Buffer.from(text).toString("base64");
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);

	if (nativeOk) return;

	// Also try platform-specific shell tools (best effort for local sessions)
	const p = platform();
	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	try {
		if (p === "darwin") {
			execSync("pbcopy", options);
		} else if (p === "win32") {
			execSync("clip", options);
		} else {
			// Linux. Try Termux, Wayland, or X11 clipboard tools.
			if (process.env.TERMUX_VERSION) {
				try {
					execSync("termux-clipboard-set", options);
					return;
				} catch {
					// Fall back to Wayland or X11 tools.
				}
			}

			const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
			const hasX11Display = Boolean(process.env.DISPLAY);
			const isWayland = isWaylandSession();
			if (isWayland && hasWaylandDisplay) {
				try {
					// Verify wl-copy exists (spawn errors are async and won't be caught)
					execSync("which wl-copy", { stdio: "ignore" });
					// wl-copy with execSync hangs due to fork behavior; use spawn instead
					const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
					proc.stdin.on("error", () => {
						// Ignore EPIPE errors if wl-copy exits early
					});
					proc.stdin.write(text);
					proc.stdin.end();
					proc.unref();
				} catch {
					if (hasX11Display) {
						copyToX11Clipboard(options);
					}
				}
			} else if (hasX11Display) {
				copyToX11Clipboard(options);
			}
		}
	} catch {
		// Ignore - OSC 52 already emitted as fallback
	}
}
