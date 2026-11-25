// The command menu's Recent group: the ids of the last commands run from it, newest first, kept per browser.

const KEY = "p2-command-recents-v1";
const LIMIT = 8;

/** The recently run command ids, newest first; an unreadable or foreign value reads as none. */
export function readRecents(): readonly string[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, LIMIT) : [];
	} catch {
		return [];
	}
}

/** Puts `id` first in the recently run commands, keeping the last `LIMIT`. */
export function recordRecent(id: string): void {
	try {
		localStorage.setItem(
			KEY,
			JSON.stringify([id, ...readRecents().filter((recent) => recent !== id)].slice(0, LIMIT)),
		);
	} catch {
		// Storage refused (private mode, full): the Recent group is a convenience and stays as it was.
	}
}
