import { extractAnsiCode } from "../utils.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine, type TerminalColor, type TextStyle } from "./styles.ts";

interface MutableStyle {
	foreground: TerminalColor;
	background: TerminalColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strikethrough: boolean;
}

function freshStyle(): MutableStyle {
	return {
		foreground: { kind: "default" },
		background: { kind: "default" },
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		blink: false,
		inverse: false,
		hidden: false,
		strikethrough: false,
	};
}

function snapshot(style: MutableStyle): TextStyle {
	return {
		foreground: style.foreground,
		background: style.background,
		bold: style.bold,
		dim: style.dim,
		italic: style.italic,
		underline: style.underline,
		blink: style.blink,
		inverse: style.inverse,
		hidden: style.hidden,
		strikethrough: style.strikethrough,
	};
}

function resetStyle(style: MutableStyle): void {
	Object.assign(style, freshStyle());
}

function applySgr(style: MutableStyle, params: string): void {
	// Empty parameters (`\x1b[m`) mean a full reset, matching v1's AnsiCodeTracker.
	if (params === "") {
		resetStyle(style);
		return;
	}
	const parts = params.split(";");
	let i = 0;
	while (i < parts.length) {
		const code = Number.parseInt(parts[i]!, 10);
		if ((code === 38 || code === 48) && parts[i + 1] === "5" && parts[i + 2] !== undefined) {
			const color: TerminalColor = { kind: "indexed", index: Number.parseInt(parts[i + 2]!, 10) || 0 };
			if (code === 38) style.foreground = color;
			else style.background = color;
			i += 3;
			continue;
		}
		if ((code === 38 || code === 48) && parts[i + 1] === "2" && parts[i + 4] !== undefined) {
			const color: TerminalColor = {
				kind: "rgb",
				red: Number.parseInt(parts[i + 2]!, 10) || 0,
				green: Number.parseInt(parts[i + 3]!, 10) || 0,
				blue: Number.parseInt(parts[i + 4]!, 10) || 0,
			};
			if (code === 38) style.foreground = color;
			else style.background = color;
			i += 5;
			continue;
		}
		applySgrCode(style, code);
		i++;
	}
}

function applySgrCode(style: MutableStyle, code: number): void {
	switch (code) {
		case 0:
			resetStyle(style);
			return;
		case 1:
			style.bold = true;
			return;
		case 2:
			style.dim = true;
			return;
		case 3:
			style.italic = true;
			return;
		case 4:
			style.underline = true;
			return;
		case 5:
			style.blink = true;
			return;
		case 7:
			style.inverse = true;
			return;
		case 8:
			style.hidden = true;
			return;
		case 9:
			style.strikethrough = true;
			return;
		case 21:
		case 22:
			style.bold = false;
			if (code === 22) style.dim = false;
			return;
		case 23:
			style.italic = false;
			return;
		case 24:
			style.underline = false;
			return;
		case 25:
			style.blink = false;
			return;
		case 27:
			style.inverse = false;
			return;
		case 28:
			style.hidden = false;
			return;
		case 29:
			style.strikethrough = false;
			return;
		case 39:
			style.foreground = { kind: "default" };
			return;
		case 49:
			style.background = { kind: "default" };
			return;
		default:
			if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				style.foreground = { kind: "indexed", index: code < 90 ? code - 30 : code - 90 + 8 };
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				style.background = { kind: "indexed", index: code < 100 ? code - 40 : code - 100 + 8 };
			}
	}
}

function parseOsc8Url(code: string): string | undefined {
	// code is `\x1b]8;<params>;<url><terminator>`; an empty url closes the active link.
	const terminator = code.endsWith("\x07") ? 1 : 2;
	const body = code.slice(4, code.length - terminator);
	const separator = body.indexOf(";");
	if (separator === -1) return undefined;
	const url = body.slice(separator + 1);
	return url.length === 0 ? undefined : url;
}

/**
 * Parse an ANSI-encoded string (as produced by Pi's v1 renderers) into structured styled lines.
 *
 * Recognizes SGR attributes/colors and OSC-8 hyperlinks with the same grammar as v1's AnsiCodeTracker,
 * so a v1 renderer's output round-trips through the v2 style model. Style and link state carry across
 * hard newlines; other control sequences (cursor moves, clears, APC markers) are dropped because
 * ledger content must not carry terminal control.
 */
export function ansiToStyledLines(text: string): StyledLine[] {
	const style = freshStyle();
	let link: string | undefined;
	const lines: StyledLine[] = [];
	let current: StyledLine = [];
	let pending = "";

	const flushSpan = (): void => {
		if (pending.length === 0) return;
		current.push(
			link === undefined
				? { text: pending, style: snapshot(style) }
				: { text: pending, style: snapshot(style), link },
		);
		pending = "";
	};
	const endLine = (): void => {
		flushSpan();
		lines.push(current);
		current = [];
	};

	let position = 0;
	while (position < text.length) {
		const char = text[position]!;
		if (char === "\x1b") {
			const extracted = extractAnsiCode(text, position);
			if (!extracted) {
				position++;
				continue;
			}
			flushSpan();
			if (extracted.code.endsWith("m")) {
				applySgr(style, extracted.code.slice(2, -1));
			} else if (extracted.code.startsWith("\x1b]8;")) {
				link = parseOsc8Url(extracted.code);
			}
			position += extracted.length;
			continue;
		}
		if (char === "\n") {
			endLine();
			position++;
			continue;
		}
		if (char === "\r") {
			position++;
			continue;
		}
		pending += char;
		position++;
	}
	endLine();
	return lines;
}

/** Parse a single ANSI line, ignoring any embedded newlines beyond the first segment. */
export function ansiToStyledLine(text: string): StyledLine {
	return ansiToStyledLines(text)[0] ?? [];
}

export { DEFAULT_TEXT_STYLE };
