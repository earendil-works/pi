import stringWidth from "string-width";

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	const normalized = str.replace(/\t/g, "   ");
	return stringWidth(normalized);
}

/**
 * Extract ANSI escape sequences from a string at the given position.
 */
function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b" || str[pos + 1] !== "[") {
		return null;
	}

	let j = pos + 2;
	while (j < str.length && str[j] && !/[mGKHJ]/.test(str[j]!)) {
		j++;
	}

	if (j < str.length) {
		return {
			code: str.substring(pos, j + 1),
			length: j + 1 - pos,
		};
	}

	return null;
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
	private modifiers: Map<number, string> = new Map();
	private foreground?: string;
	private background?: string;
	private otherCodes: string[] = [];

	process(ansiCode: string): void {
		if (!ansiCode.endsWith("m")) {
			return;
		}

		const paramsText = ansiCode.slice(2, -1);
		const rawParams = paramsText.length === 0 ? ["0"] : paramsText.split(";");

		for (let i = 0; i < rawParams.length; i++) {
			const raw = rawParams[i] ?? "0";
			const param = Number.parseInt(raw, 10);
			if (!Number.isFinite(param)) continue;

			if (param === 0) {
				this.modifiers.clear();
				this.foreground = undefined;
				this.background = undefined;
				this.otherCodes = [];
				continue;
			}

			if (param === 38 || param === 48) {
				const mode = rawParams[i + 1];
				if (mode === undefined) continue;
				const chunkLength = mode === "2" ? 5 : mode === "5" ? 3 : 1;
				const chunk = rawParams.slice(i, i + chunkLength).join(";");
				const code = `\x1b[${chunk}m`;
				if (param === 38) {
					this.foreground = code;
				} else {
					this.background = code;
				}
				i += chunkLength - 1;
				continue;
			}

			const code = `\x1b[${param}m`;

			if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) {
				this.foreground = code;
				continue;
			}
			if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
				this.background = code;
				continue;
			}
			if (param === 39) {
				this.foreground = undefined;
				continue;
			}
			if (param === 49) {
				this.background = undefined;
				continue;
			}

			if ([1, 2, 3, 4, 5, 7, 8, 9].includes(param)) {
				this.modifiers.set(param, code);
				continue;
			}
			if (param === 22) {
				this.modifiers.delete(1);
				this.modifiers.delete(2);
				continue;
			}
			if (param === 23) {
				this.modifiers.delete(3);
				continue;
			}
			if (param === 24) {
				this.modifiers.delete(4);
				continue;
			}
			if (param === 25) {
				this.modifiers.delete(5);
				continue;
			}
			if (param === 27) {
				this.modifiers.delete(7);
				continue;
			}
			if (param === 28) {
				this.modifiers.delete(8);
				continue;
			}
			if (param === 29) {
				this.modifiers.delete(9);
				continue;
			}

			this.otherCodes.push(code);
		}
	}

	getActiveCodes(): string {
		return [
			...this.modifiers.values(),
			...(this.foreground ? [this.foreground] : []),
			...(this.background ? [this.background] : []),
			...this.otherCodes,
		].join("");
	}

	hasActiveCodes(): boolean {
		return (
			this.modifiers.size > 0 ||
			this.foreground !== undefined ||
			this.background !== undefined ||
			this.otherCodes.length > 0
		);
	}
}

function closeActiveAnsi(text: string, tracker: AnsiCodeTracker): string {
	if (!tracker.hasActiveCodes()) return text;
	if (text.endsWith("\x1b[0m")) return text;
	return `${text}\x1b[0m`;
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = 0;
	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			tracker.process(ansiResult.code);
			i += ansiResult.length;
		} else {
			i++;
		}
	}
}

/**
 * Split text into words while keeping ANSI codes attached.
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inWhitespace = false;
	let i = 0;

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			current += ansiResult.code;
			i += ansiResult.length;
			continue;
		}

		const char = text[i];
		const charIsSpace = char === " ";

		if (charIsSpace !== inWhitespace && current) {
			// Switching between whitespace and non-whitespace, push current token
			tokens.push(current);
			current = "";
		}

		inWhitespace = charIsSpace;
		current += char;
		i++;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// Handle newlines by processing each line separately
	const inputLines = text.split("\n");
	const result: string[] = [];

	for (const inputLine of inputLines) {
		result.push(...wrapSingleLine(inputLine, width));
	}

	return result.length > 0 ? result : [""];
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) {
		return [""];
	}

	const visibleLength = visibleWidth(line);
	if (visibleLength <= width) {
		return [line];
	}

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const tokens = splitIntoTokensWithAnsi(line);

	let currentLine = "";
	let currentVisibleLength = 0;

	for (const token of tokens) {
		const tokenVisibleLength = visibleWidth(token);
		const isWhitespace = token.trim() === "";

		// Token itself is too long - break it character by character
		if (tokenVisibleLength > width && !isWhitespace) {
			if (currentLine) {
				wrapped.push(closeActiveAnsi(currentLine, tracker));
				currentLine = "";
				currentVisibleLength = 0;
			}

			// Break long token
			const broken = breakLongWord(token, width, tracker);
			wrapped.push(...broken.slice(0, -1));
			currentLine = broken[broken.length - 1];
			currentVisibleLength = visibleWidth(currentLine);
			continue;
		}

		// Check if adding this token would exceed width
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		if (totalNeeded > width && currentVisibleLength > 0) {
			// Wrap to next line - trim trailing whitespace from current line
			wrapped.push(closeActiveAnsi(currentLine.trimEnd(), tracker));
			if (isWhitespace) {
				// Don't start new line with whitespace
				currentLine = tracker.getActiveCodes();
				currentVisibleLength = 0;
			} else {
				currentLine = tracker.getActiveCodes() + token;
				currentVisibleLength = tokenVisibleLength;
			}
		} else {
			// Add to current line
			currentLine += token;
			currentVisibleLength += tokenVisibleLength;
		}

		updateTrackerFromText(token, tracker);
	}

	if (currentLine) {
		wrapped.push(closeActiveAnsi(currentLine, tracker));
	}

	return wrapped.length > 0 ? wrapped : [""];
}

// Grapheme segmenter for proper Unicode iteration (handles emojis, etc.)
const segmenter = new Intl.Segmenter();

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	const lines: string[] = [];
	let currentLine = tracker.getActiveCodes();
	let currentWidth = 0;

	// First, separate ANSI codes from visible content
	// We need to handle ANSI codes specially since they're not graphemes
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	while (i < word.length) {
		const ansiResult = extractAnsiCode(word, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// Find the next ANSI code or end of string
			let end = i;
			while (end < word.length) {
				const nextAnsi = extractAnsiCode(word, end);
				if (nextAnsi) break;
				end++;
			}
			// Segment this non-ANSI portion into graphemes
			const textPortion = word.slice(i, end);
			for (const seg of segmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// Now process segments
	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > width) {
			lines.push(closeActiveAnsi(currentLine, tracker));
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		lines.push(closeActiveAnsi(currentLine, tracker));
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// Apply background to content + padding
	const withPadding = line + padding;
	return bgFn(withPadding);
}
