let cursorAccentBgAnsi = "\x1b[48;2;120;220;232m";
let cursorAccentFgAnsi = "\x1b[38;2;24;28;32m";
const CURSOR_RESET_FG = "\x1b[39m";
const CURSOR_RESET_BG = "\x1b[49m";

export interface CursorAccentAnsi {
	fgAnsi: string;
	bgAnsi: string;
}

export type CursorStyle = "accentBlock" | "reverse" | "underline";

export function renderCursorCell(text: string, style: CursorStyle, accent?: CursorAccentAnsi): string {
	if (style === "underline") {
		return `\x1b[4m${text}\x1b[24m`;
	}

	if (style === "reverse") {
		return `\x1b[7m${text}\x1b[27m`;
	}

	const fgAnsi = accent?.fgAnsi ?? cursorAccentFgAnsi;
	const bgAnsi = accent?.bgAnsi ?? cursorAccentBgAnsi;
	return `${fgAnsi}${bgAnsi}${text}${CURSOR_RESET_FG}${CURSOR_RESET_BG}`;
}

export function setCursorAccentAnsi(fgAnsi: string, bgAnsi: string): void {
	cursorAccentFgAnsi = fgAnsi;
	cursorAccentBgAnsi = bgAnsi;
}

export const DEFAULT_CURSOR_STYLE: CursorStyle = "accentBlock";

export function getCursorAccentBgAnsi(): string {
	return cursorAccentBgAnsi;
}

export function getCursorAccentFgAnsi(): string {
	return cursorAccentFgAnsi;
}
