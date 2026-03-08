import type { Component } from "@kennyfrc/mu-tui";
import { Text, visibleWidth } from "@kennyfrc/mu-tui";

const DEFAULT_MAX_PREVIEW_LINES = 4;

function clampRenderedLines(lines: string[], width: number, maxLines: number): string[] {
	if (lines.length <= maxLines) return lines;

	const clamped = lines.slice(0, maxLines);
	const lastLine = clamped[maxLines - 1] ?? "";
	const withoutTrailingSpaces = lastLine.replace(/ +$/u, "");
	const ellipsized = `${withoutTrailingSpaces}…`;
	const paddingNeeded = Math.max(0, width - visibleWidth(ellipsized));
	clamped[maxLines - 1] = ellipsized + " ".repeat(paddingNeeded);
	return clamped;
}

export class QueuedMessagePreviewComponent implements Component {
	private readonly text: Text;

	constructor(
		formattedText: string,
		private readonly maxPreviewLines: number = DEFAULT_MAX_PREVIEW_LINES,
		paddingX: number = 1,
		paddingY: number = 0,
	) {
		this.text = new Text(formattedText, paddingX, paddingY);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	render(width: number): string[] {
		const rendered = this.text.render(width);
		return clampRenderedLines(rendered, width, this.maxPreviewLines);
	}
}

export { DEFAULT_MAX_PREVIEW_LINES, clampRenderedLines };
