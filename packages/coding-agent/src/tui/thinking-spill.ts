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

	return { thinking, text };
}
