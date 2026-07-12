import { ansiToStyledLines } from "./ansi-parse.ts";
import type { BlockRenderer } from "./ledger.ts";
import { plainLine, type StyledLine } from "./styles.ts";

function stripTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * Renders a plain-text model to one styled line per newline-separated row. A single trailing newline
 * is dropped so `"a\n"` is one line, matching how the ledger frontiers treat completed lines.
 */
export const plainTextRenderer: BlockRenderer<string, unknown> = {
	render(model: string): StyledLine[] {
		return stripTrailingNewline(model)
			.split("\n")
			.map((line) => plainLine(line));
	},
};

/**
 * Renders an ANSI-encoded model (as produced by Pi's v1 renderers) to structured styled lines,
 * bridging existing markdown/tool/diff renderers into the v2 ledger without rewriting them.
 */
export const ansiTextRenderer: BlockRenderer<string, unknown> = {
	render(model: string): StyledLine[] {
		return ansiToStyledLines(stripTrailingNewline(model));
	},
};

/** Wraps a pure `(model, width, theme) -> StyledLine[]` function as a block renderer. */
export function functionRenderer<Model, Theme>(
	render: (model: Model, width: number, theme: Theme) => StyledLine[],
): BlockRenderer<Model, Theme> {
	return { render };
}
