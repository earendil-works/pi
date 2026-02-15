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
 * Some models add 1-2 leading spaces to lines in thinking traces and responses.
 * This is jarring during streaming. We strip consistent leading indentation across
 * all non-blank lines while preserving relative indentation for intentional structure.
 *
 * This preserves:
 * - Nested lists (relative indentation preserved)
 * - Indented code blocks (relative indentation preserved)
 * - Fenced code blocks (backticks - content inside is preserved)
 */
export function normalizeExcessiveWhitespace(text: string): string {
	const lines = text.split("\n");

	// Find the minimum leading spaces across all non-empty lines
	let minIndent = Infinity;
	for (const line of lines) {
		if (line.trim().length === 0) continue; // Skip empty lines
		const leadingSpaces = line.match(/^( *)/)?.[1]?.length ?? 0;
		if (leadingSpaces < minIndent) {
			minIndent = leadingSpaces;
		}
		// Stop early if we hit 0 - can't strip less than 0
		if (minIndent === 0) break;
	}

	// If all lines have at least 1 leading space, strip that common prefix
	if (minIndent > 0 && minIndent !== Infinity) {
		return lines.map((line) => line.slice(minIndent)).join("\n");
	}

	return text;
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
