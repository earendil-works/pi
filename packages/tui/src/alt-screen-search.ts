import { Input } from "./components/input.ts";
import { getKeybindings } from "./keybindings.ts";
import type { Component, Focusable } from "./tui.ts";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

function appendMappedText(
	text: string,
	span: SearchSourceSpan | undefined,
	corpus: { text: string; source: Array<SearchSourceSpan | undefined> },
): void {
	corpus.text += text;
	for (let index = 0; index < text.length; index++) corpus.source.push(span);
}

function buildSearchCorpus(lines: readonly string[]): {
	text: string;
	source: Array<SearchSourceSpan | undefined>;
} {
	const corpus: { text: string; source: Array<SearchSourceSpan | undefined> } = { text: "", source: [] };
	let pendingSeparator = false;

	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		let column = 0;
		for (const grapheme of segmenter.segment(line)) {
			const text = grapheme.segment;
			const width = visibleWidth(text);
			if (/^\s+$/u.test(text)) {
				if (corpus.text.length > 0) pendingSeparator = true;
				column += width;
				continue;
			}
			if (pendingSeparator) {
				appendMappedText(" ", undefined, corpus);
				pendingSeparator = false;
			}
			appendMappedText(text, { row, startCol: column, endCol: column + width }, corpus);
			column += width;
		}
		if (corpus.text.length > 0) pendingSeparator = true;
	}

	return corpus;
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	if (!normalizedQuery) return [];

	const corpus = buildSearchCorpus(lines);
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: AltScreenSearchMatch[] = [];

	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		const segments: AltScreenSearchSegment[] = [];
		for (let index = start; index < end; index++) {
			const span = corpus.source[index];
			if (!span) continue;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && span.startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, span.endCol);
			} else {
				segments.push({ ...span });
			}
		}
		if (segments.length > 0) matches.push({ segments });
	}

	return matches;
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export class AltScreenSearchComponent implements Component, Focusable {
	private readonly input = new Input({
		prompt: " ",
		placeholder: "Find in transcript",
		placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
	});
	private readonly onQueryChange: (query: string) => void;
	private readonly navigationButtonStyle: (text: string, hovered: boolean) => string;
	private resultCount = 0;
	private resultIndex = -1;
	private previousButtonStart = -1;
	private previousButtonEnd = -1;
	private nextButtonStart = -1;
	private nextButtonEnd = -1;
	private hoveredNavigationDirection: -1 | 1 | undefined;
	private _focused = false;

	constructor(
		onQueryChange: (query: string) => void,
		navigationButtonStyle: (text: string, hovered: boolean) => string = (text) => text,
	) {
		this.onQueryChange = onQueryChange;
		this.navigationButtonStyle = navigationButtonStyle;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	setResult(index: number, count: number): void {
		this.resultIndex = index;
		this.resultCount = count;
	}

	getNavigationDirectionAt(row: number, column: number): -1 | 1 | undefined {
		if (row !== 2) return undefined;
		if (column >= this.previousButtonStart && column < this.previousButtonEnd) return -1;
		if (column >= this.nextButtonStart && column < this.nextButtonEnd) return 1;
		return undefined;
	}

	setHoveredNavigationDirection(direction: -1 | 1 | undefined): boolean {
		if (direction === this.hoveredNavigationDirection) return false;
		this.hoveredNavigationDirection = direction;
		return true;
	}

	handleInput(data: string): void {
		const previous = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query !== previous) this.onQueryChange(query);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const innerWidth = Math.max(0, safeWidth - 2);
		const formatKey = (key: string | undefined): string =>
			key
				? key
						.split("+")
						.map((part) => {
							if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
							return part.charAt(0).toUpperCase() + part.slice(1);
						})
						.join("+")
				: "Unbound";
		const keybindings = getKeybindings();
		const previousKey = formatKey(keybindings.getKeys("tui.altScreen.searchPrevious")[0]);
		const nextKey = formatKey(keybindings.getKeys("tui.altScreen.searchNext")[0]);
		const query = this.input.getValue();
		const result = !query
			? ""
			: this.resultCount === 0
				? "No matches"
				: `${this.resultIndex + 1}/${this.resultCount}`;
		const resultSpace = Math.max(0, innerWidth - 3);
		const visibleResult = truncateToWidth(result, resultSpace, "");
		const resultText = visibleResult ? `\x1b[2m ${visibleResult} \x1b[22m` : "";
		const inputWidth = Math.max(0, innerWidth - visibleWidth(resultText));
		const inputLine = truncateToWidth(this.input.render(Math.max(1, inputWidth))[0] ?? "", inputWidth, "");
		const inputPadding = " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
		const content = `${inputLine}${inputPadding}${resultText}`;

		let previousButton = `↑ ${previousKey}`;
		let nextButton = `↓ ${nextKey}`;
		let separator = " · ";
		const outerGapWidth = 1;
		const availableControlsWidth = Math.max(0, innerWidth - outerGapWidth * 2 - 1);
		let controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		if (controlsWidth > availableControlsWidth) {
			previousButton = "↑";
			nextButton = "↓";
			separator = " ";
			controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		}
		const showButtons = controlsWidth <= availableControlsWidth;
		const renderedButtons = showButtons
			? this.navigationButtonStyle(previousButton, this.hoveredNavigationDirection === -1) +
				separator +
				this.navigationButtonStyle(nextButton, this.hoveredNavigationDirection === 1)
			: "";
		const outerGapsWidth = showButtons ? outerGapWidth * 2 : 0;
		const rightRuleWidth = renderedButtons && innerWidth > controlsWidth + outerGapsWidth ? 1 : 0;
		const leftRuleWidth = Math.max(
			0,
			innerWidth - (showButtons ? controlsWidth : 0) - outerGapsWidth - rightRuleWidth,
		);
		const previousStart = 1 + leftRuleWidth + outerGapWidth;
		this.previousButtonStart = showButtons ? previousStart : -1;
		this.previousButtonEnd = showButtons ? previousStart + visibleWidth(previousButton) : -1;
		this.nextButtonStart = showButtons ? this.previousButtonEnd + visibleWidth(separator) : -1;
		this.nextButtonEnd = showButtons ? this.nextButtonStart + visibleWidth(nextButton) : -1;

		if (safeWidth === 1) return ["┌", "│", "└"];
		return [
			`┌${"─".repeat(innerWidth)}┐`,
			`│${content}│`,
			`└${"─".repeat(leftRuleWidth)}${renderedButtons ? " " : ""}${renderedButtons}${renderedButtons ? " " : ""}${"─".repeat(rightRuleWidth)}┘`,
		];
	}
}
