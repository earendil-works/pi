export type ThinkingSpillExactDuplicateStrategy = "keepBoth" | "dropThinking" | "dropText";

export interface ThinkingSpillFixOptions {
	/**
	 * If thinking and text are identical, choose which one to drop.
	 *
	 * - keepBoth: render both (no dedupe)
	 * - dropThinking: keep text only
	 * - dropText: keep thinking only
	 */
	exactDuplicateStrategy?: ThinkingSpillExactDuplicateStrategy;
}

export interface ThinkingSpillFixResult {
	thinking: string;
	text: string;
}

/**
 * Normalize excessive leading whitespace from lines.
 *
 * Some models add a small, consistent leading indentation to lines in thinking traces
 * and responses. This is jarring during streaming. We strip common leading whitespace
 * from all non-blank lines while preserving relative indentation for intentional
 * structure.
 *
 * This preserves:
 * - Nested lists (relative indentation preserved)
 * - Indented code blocks (relative indentation preserved)
 * - Tab-indented blocks (tabs are normalized alongside spaces)
 * - Fenced code blocks (backticks - content inside is preserved)
 */
export function normalizeExcessiveWhitespace(text: string): string {
	const lines = text.split("\n");
	const linesWithContent = lines.filter((line) => line.trim().length > 0);
	if (linesWithContent.length === 0) {
		return text;
	}

	let commonIndent = linesWithContent[0]?.match(/^[ \t]*/)?.[0] ?? "";
	for (let i = 1; i < linesWithContent.length; i++) {
		const indent = linesWithContent[i]?.match(/^[ \t]*/)?.[0] ?? "";
		if (indent.length < commonIndent.length) {
			commonIndent = indent;
		}

		while (commonIndent.length > 0 && !indent.startsWith(commonIndent)) {
			commonIndent = commonIndent.slice(0, -1);
		}

		if (commonIndent.length === 0) {
			break;
		}
	}

	if (commonIndent.length > 0) {
		return lines
			.map((line) => {
				if (line.trim().length === 0) return line;
				return line.startsWith(commonIndent) ? line.slice(commonIndent.length) : line;
			})
			.join("\n");
	}

	return text;
}

/**
 * Normalize awkward punctuation continuations caused by token/newline artifacts.
 *
 * Example:
 * - "Hey\n ! Doing well" -> "Hey! Doing well"
 * - "Hello !" -> "Hello!"
 *
 * Intentionally conservative:
 * - only joins when punctuation follows a letter/number
 * - skips markdown image syntax like `![alt](...)`
 */
export function normalizePunctuationSpacing(text: string): string {
	return text
		.replace(/([\p{L}\p{N}])(?:[ \t]*\n[ \t]*)+([!?.,])(?!\[)/gu, "$1$2")
		.replace(/([\p{L}\p{N}])(?:[ \t]+)([!?.,])(?!\[)/gu, "$1$2");
}

/**
 * Best-effort guard to prevent "thinking" content from being duplicated/spilled
 * into the visible response text.
 */
export function fixThinkingSpill(
	thinking: string,
	text: string,
	options: ThinkingSpillFixOptions = {},
): ThinkingSpillFixResult {
	const thinkingTrimmed = thinking.trim();
	const textTrimmed = text.trim();

	// Nothing to reconcile.
	if (!thinkingTrimmed || !textTrimmed) {
		return { thinking, text };
	}

	const exactDuplicateStrategy = options.exactDuplicateStrategy ?? "keepBoth";

	// Exact duplicates: keep a single copy.
	if (textTrimmed === thinkingTrimmed) {
		switch (exactDuplicateStrategy) {
			case "dropThinking":
				return { thinking: "", text };
			case "dropText":
				return { thinking, text: "" };
			default:
				return { thinking, text };
		}
	}

	// Prefix spill: response starts by repeating the thinking trace.
	if (textTrimmed.startsWith(thinkingTrimmed)) {
		// Try to find the trimmed thinking at the beginning of the raw text (allowing
		// for leading whitespace differences), then strip it from the *raw* text.
		const idx = text.indexOf(thinkingTrimmed);
		if (idx !== -1 && text.slice(0, idx).trim().length === 0) {
			const stripped = text.slice(idx + thinkingTrimmed.length).trimStart();
			return { thinking, text: stripped };
		}

		// Fallback: compute using trimmed strings.
		const stripped = textTrimmed.slice(thinkingTrimmed.length).trimStart();
		return { thinking, text: stripped };
	}

	// Suffix spill: response ends by repeating the thinking trace.
	//
	// This can happen when a provider/model appends the full thinking blob after the
	// visible answer (or when the message block order is [text, thinking]).
	if (textTrimmed.endsWith(thinkingTrimmed)) {
		// Prefer stripping from the raw text so we preserve any mid-string whitespace
		// outside the duplicated suffix.
		const idx = text.lastIndexOf(thinkingTrimmed);
		if (idx !== -1 && text.slice(idx + thinkingTrimmed.length).trim().length === 0) {
			const stripped = text.slice(0, idx).trimEnd();
			return { thinking, text: stripped };
		}

		// Fallback: compute using trimmed strings.
		const stripped = textTrimmed.slice(0, textTrimmed.length - thinkingTrimmed.length).trimEnd();
		return { thinking, text: stripped };
	}

	return { thinking, text };
}
