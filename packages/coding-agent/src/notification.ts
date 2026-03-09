import { exec } from "child_process";

export type TerminalNotificationBackend = "osc9" | "osc777";

type NotificationEnv = Record<string, string | undefined>;

function escapeOscComponent(value: string): string {
	return value.replace(/[\u0007\u001b]/g, " ").replace(/;/g, ":");
}

export function detectTerminalNotificationBackend(
	env: NotificationEnv = process.env,
	isTTY: boolean = process.stdout.isTTY === true,
): TerminalNotificationBackend | null {
	if (!isTTY) return null;
	if (env.WT_SESSION) return null;

	if (env.ITERM_SESSION_ID) {
		return "osc9";
	}

	if (env.TERM_PROGRAM === "iTerm.app") {
		return "osc9";
	}

	if (env.TERM === "wezterm" || env.TERM === "wezterm-mux") {
		return "osc9";
	}

	return null;
}

export function buildTerminalNotificationSequence(
	backend: TerminalNotificationBackend,
	title: string,
	message: string,
): string {
	const safeTitle = escapeOscComponent(title);
	const safeMessage = escapeOscComponent(message);

	if (backend === "osc777") {
		return `\u001b]777;notify;${safeTitle};${safeMessage}\u0007`;
	}

	const combined = safeTitle ? `${safeTitle}: ${safeMessage}` : safeMessage;
	return `\u001b]9;${combined}\u0007`;
}

/**
 * Send a macOS notification.
 * Prefers terminal-native OSC notifications when supported by the current
 * terminal (matching Codex-style Ghostty/iTerm behavior), and falls back to
 * osascript otherwise.
 * No-op on non-macOS platforms.
 * Fire-and-forget: does not block and ignores errors.
 */
export function sendNotification(title: string, message: string): void {
	if (process.platform !== "darwin") return;

	const terminalBackend = detectTerminalNotificationBackend();
	if (terminalBackend) {
		try {
			process.stdout.write(buildTerminalNotificationSequence(terminalBackend, title, message));
			return;
		} catch {
			// Fall back to osascript below.
		}
	}

	// Escape for AppleScript double-quoted string (backslash and double quote)
	const escapeForAppleScript = (str: string) => str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

	// Escape single quotes for shell single-quoted string: ' → '\''
	const escapeForShell = (str: string) => str.replace(/'/g, "'\\''");

	const escapedTitle = escapeForShell(escapeForAppleScript(title));
	const escapedMessage = escapeForShell(escapeForAppleScript(message));

	const script = `display notification "${escapedMessage}" with title "${escapedTitle}"`;

	exec(`osascript -e '${script}'`, (error) => {
		// Silently ignore errors - notification is best-effort
		if (error) {
			// Debug log if needed, but don't spam console
			// console.debug("Notification error:", error.message);
		}
	});
}

/**
 * Play a subtle notification sound on macOS.
 * No-op on non-macOS platforms.
 * Uses Tink.aiff for notifications.
 * Fire-and-forget: does not block and ignores errors.
 */
export function playNotificationSound(): void {
	if (process.platform !== "darwin") return;

	const soundPath = "/System/Library/Sounds/Tink.aiff";

	// Fire-and-forget; ignore errors (e.g., afplay missing)
	exec(`afplay '${soundPath}'`, () => {
		// Silently ignore errors - sound is best-effort
	});
}
