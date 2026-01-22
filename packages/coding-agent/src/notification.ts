import { exec } from "child_process";

/**
 * Send a macOS notification using osascript.
 * No-op on non-macOS platforms.
 * Fire-and-forget: does not block and ignores errors.
 */
export function sendNotification(title: string, message: string): void {
	if (process.platform !== "darwin") return;

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
 * Uses Pop.aiff for notifications.
 * Fire-and-forget: does not block and ignores errors.
 */
export function playNotificationSound(): void {
	if (process.platform !== "darwin") return;

	const soundPath = "/System/Library/Sounds/Pop.aiff";

	// Fire-and-forget; ignore errors (e.g., afplay missing)
	exec(`afplay '${soundPath}'`, () => {
		// Silently ignore errors - sound is best-effort
	});
}
