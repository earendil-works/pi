/**
 * Detect a Windows host terminal that intercepts Ctrl+V as a text paste.
 *
 * Covers the common Windows terminals:
 * - Windows Terminal: sets `WT_SESSION` (and `WT_PROFILE_ID`). These are
 *   inherited by processes running inside a WSL session launched from a
 *   Windows Terminal tab.
 * - Hyper: sets `TERM_PROGRAM=Hyper`.
 * - conhost (the legacy Windows console host): exposes no dedicated env
 *   marker, so it is detected as the Windows fallback: `win32` with neither
 *   `WT_SESSION` nor `TERM_PROGRAM` set.
 *
 * This enables the empty-bracketed-paste clipboard-image heuristic, because
 * these terminals intercept Ctrl+V as a text paste and emit an empty bracketed
 * paste when the clipboard holds an image rather than text.
 */
export function isCtrlVPasteInterceptingTerminal(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (env.WT_SESSION) {
		return true;
	}
	if (env.TERM_PROGRAM === "Hyper") {
		return true;
	}
	// conhost has no distinguishing env var; treat a Windows console with no
	// terminal markers (no WT_SESSION, no TERM_PROGRAM) as conhost. A set
	// TERM_PROGRAM means some other terminal we don't know intercepts Ctrl+V.
	return platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Detect a self-contained empty bracketed paste.
 *
 * Returns true only when the start and end markers appear in the same chunk
 * with an empty payload between them. Ongoing multi-chunk pastes (a start
 * marker without a matching end marker) return false so the editor can buffer
 * them normally. A whitespace-only payload is treated as real pasted text
 * (e.g. copied indentation or blank lines), not the image signal. Windows host
 * terminals (Windows Terminal, Hyper, conhost) emit exactly this empty form
 * when Ctrl+V is pressed while the clipboard holds an image instead of text.
 */
export function isEmptyBracketedPaste(data: string): boolean {
	const start = data.indexOf(BRACKETED_PASTE_START);
	if (start === -1) {
		return false;
	}
	const end = data.indexOf(BRACKETED_PASTE_END, start + BRACKETED_PASTE_START.length);
	if (end === -1) {
		return false;
	}
	return end === start + BRACKETED_PASTE_START.length;
}
