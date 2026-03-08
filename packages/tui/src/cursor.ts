const CURSOR_ACCENT_BG = "\x1b[48;2;120;220;232m";
const CURSOR_ACCENT_FG = "\x1b[38;2;24;28;32m";
const CURSOR_RESET_FG = "\x1b[39m";
const CURSOR_RESET_BG = "\x1b[49m";

export type CursorStyle = "accentBlock" | "reverse" | "underline";

export function renderCursorCell(text: string, style: CursorStyle): string {
	if (style === "underline") {
		return `\x1b[4m${text}\x1b[24m`;
	}

	if (style === "reverse") {
		return `\x1b[7m${text}\x1b[27m`;
	}

	return `${CURSOR_ACCENT_FG}${CURSOR_ACCENT_BG}${text}${CURSOR_RESET_FG}${CURSOR_RESET_BG}`;
}

export const DEFAULT_CURSOR_STYLE: CursorStyle = "accentBlock";
export const CURSOR_ACCENT_BG_ANSI = CURSOR_ACCENT_BG;
export const CURSOR_ACCENT_FG_ANSI = CURSOR_ACCENT_FG;
