// Store identities only, never log text. Browser persistence is best-effort (storage can be disabled).
export const DISMISSED_NOTICE_PREFIX = "pi-owner-notice-dismissed:";

export function noticeWasDismissed(id: string): boolean {
	try {
		return localStorage.getItem(DISMISSED_NOTICE_PREFIX + id) === "1";
	} catch {
		return false;
	}
}

export function rememberDismissedNotice(id: string): void {
	try {
		localStorage.setItem(DISMISSED_NOTICE_PREFIX + id, "1");
	} catch {
		/* In-memory dismissal still works. */
	}
}

/** The result messages emitted by the dev supervisor/watcher, not an arbitrary error containing these words. */
export function isSuccessResult(message: string): boolean {
	return /^Reloaded(?:\s|$)/.test(message) || message === "Restarted server" || message === "No dirty plugins";
}
