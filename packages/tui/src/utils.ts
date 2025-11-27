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
	private activeAnsiCodes: string[] = [];

	process(ansiCode: string): void {
		if (!ansiCode.endsWith("m")) {
			return;
		}

		// Full reset clears everything
		if (ansiCode === "\x1b[0m" || ansiCode === "\x1b[m") {
			this.activeAnsiCodes.length = 0;
		} else {
			this.activeAnsiCodes.push(ansiCode);
		}
	}

	getActiveCodes(): string {
		return this.activeAnsiCodes.join("");
	}

	hasActiveCodes(): boolean {
		return this.activeAnsiCodes.length > 0;
	}
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
				wrapped.push(currentLine);
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
			// Wrap to next line - don't carry trailing whitespace
			wrapped.push(currentLine);
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
		wrapped.push(currentLine);
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
			lines.push(currentLine);
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		lines.push(currentLine);
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
