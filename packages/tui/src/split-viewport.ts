import type { Component } from "./tui.ts";
import { sliceByColumn, visibleWidth } from "./utils.ts";

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/**
 * Apply horizontal split layout only to the visible viewport lines.
 * The right panel is anchored to the screen area, not to the full content
 * height, so it stays visible regardless of scroll position on the left side.
 */
export function applySplitToViewport(
	lines: string[],
	rightPanel: Component,
	ratio: number,
	termWidth: number,
	termHeight: number,
): string[] {
	const divider = "│";
	const dividerWidth = visibleWidth(divider);
	const leftWidth = Math.floor(termWidth * ratio);
	const rightWidth = termWidth - leftWidth - dividerWidth;

	if (leftWidth < 10 || rightWidth < 10) {
		return lines;
	}

	const viewportStart = Math.max(0, lines.length - termHeight);

	// Render right panel
	const rightLines = rightPanel.render(rightWidth);

	// Copy only the viewport rows, not the entire lines array
	const result = lines.slice(); // shallow copy

	for (let i = 0; i < termHeight && viewportStart + i < lines.length; i++) {
		const lineIdx = viewportStart + i;
		const left = lines[lineIdx];
		const right = i < rightLines.length ? rightLines[i] : "";

		// Fast path: if left line fits within leftWidth, just pad with spaces
		const leftVisWidth = visibleWidth(left);
		const leftPadded =
			leftVisWidth < leftWidth
				? left + " ".repeat(leftWidth - leftVisWidth)
				: leftVisWidth > leftWidth
					? sliceByColumn(left, 0, leftWidth, true)
					: left;

		// Truncate right content to rightWidth
		const rightSafe = visibleWidth(right) <= rightWidth ? right : sliceByColumn(right, 0, rightWidth, true);

		result[lineIdx] = leftPadded + SEGMENT_RESET + divider + rightSafe;
	}

	return result;
}
