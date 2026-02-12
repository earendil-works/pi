import { Text } from "@kennyfrc/mu-tui";

export interface VisualTruncateResult {
	/** Visual lines to display (already wrapped/padded to width) */
	visualLines: string[];
	/** Count of visual lines skipped (hidden) */
	skippedCount: number;
}

/**
 * Truncate text to a maximum number of *visual* lines (accounting for wrapping).
 *
 * This is especially important for tool output where a single logical line
 * (no newlines) might wrap into hundreds of terminal lines.
 *
 * Behavior: returns the last N visual lines (most recent output).
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	return {
		visualLines: allVisualLines.slice(-maxVisualLines),
		skippedCount: allVisualLines.length - maxVisualLines,
	};
}
