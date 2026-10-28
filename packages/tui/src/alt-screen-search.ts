import { Input } from "./components/input.ts";
import { getKeybindings } from "./keybindings.ts";
import type { Component, Focusable } from "./tui.ts";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	textStart: number;
	textEnd: number;
	row: number;
	startCol: number;
	endCol: number;
	linearColumns: boolean;
}

interface SearchCorpus {
	text: string;
	spans: SearchSourceSpan[];
}

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	const chunks: string[] = [];
	const spans: SearchSourceSpan[] = [];
	let textLength = 0;
	let pendingSeparator = false;

	const appendSeparator = (): void => {
		if (!pendingSeparator) return;
		chunks.push(" ");
		textLength += 1;
		pendingSeparator = false;
	};

	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		let column = 0;

		// Rendered transcripts are overwhelmingly ASCII. Index complete non-space
		// runs at once instead of segmenting and allocating one mapping per cell.
		if (PRINTABLE_ASCII.test(line)) {
			let index = 0;
			while (index < line.length) {
				if (line.charCodeAt(index) === 0x20) {
					if (textLength > 0) pendingSeparator = true;
					column += 1;
					index += 1;
					continue;
				}
				let end = index + 1;
				while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
				appendSeparator();
				const text = line.slice(index, end);
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + text.length,
					linearColumns: true,
				});
				textLength += text.length;
				column += text.length;
				index = end;
			}
		} else {
			for (const grapheme of segmenter.segment(line)) {
				const text = grapheme.segment;
				const width = visibleWidth(text);
				if (/^\s+$/u.test(text)) {
					if (textLength > 0) pendingSeparator = true;
					column += width;
					continue;
				}
				appendSeparator();
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + width,
					linearColumns: false,
				});
				textLength += text.length;
				column += width;
			}
		}
		if (textLength > 0) pendingSeparator = true;
	}

	return { text: chunks.join(""), spans };
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSearchCorpusMatches(corpus: SearchCorpus, normalizedQuery: string): AltScreenSearchMatch[] {
	if (!normalizedQuery) return [];
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: AltScreenSearchMatch[] = [];
	let spanIndex = 0;

	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= start) spanIndex += 1;

		const segments: AltScreenSearchSegment[] = [];
		for (let index = spanIndex; index < corpus.spans.length; index++) {
			const span = corpus.spans[index]!;
			if (span.textStart >= end) break;
			if (span.textEnd <= start) continue;
			const startCol = span.linearColumns
				? span.startCol + Math.max(start, span.textStart) - span.textStart
				: span.startCol;
			const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, endCol);
			} else {
				segments.push({ row: span.row, startCol, endCol });
			}
		}
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= end) spanIndex += 1;
		if (segments.length > 0) matches.push({ segments });
	}

	return matches;
}

export interface AltScreenSearchResult {
	matches: AltScreenSearchMatch[];
	changed: boolean;
}

/** Cache the searchable corpus and matches while rendered transcript lines remain unchanged. */
export class AltScreenSearchIndex {
	private sourceLines: string[] | undefined;
	private corpus: SearchCorpus | undefined;
	private normalizedQuery: string | undefined;
	private matches: AltScreenSearchMatch[] = [];

	search(lines: readonly string[], query: string): AltScreenSearchResult {
		let sourceChanged = this.sourceLines?.length !== lines.length;
		if (!sourceChanged && this.sourceLines) {
			for (let index = 0; index < lines.length; index++) {
				if (this.sourceLines[index] === lines[index]) continue;
				sourceChanged = true;
				break;
			}
		}
		if (sourceChanged || !this.corpus) {
			this.sourceLines = Array.from(lines);
			this.corpus = buildSearchCorpus(lines);
		}

		const normalizedQuery = normalizeQuery(query);
		const changed = sourceChanged || normalizedQuery !== this.normalizedQuery;
		if (changed) {
			this.normalizedQuery = normalizedQuery;
			this.matches = findSearchCorpusMatches(this.corpus, normalizedQuery);
		}
		return { matches: this.matches, changed };
	}
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	return normalizedQuery ? findSearchCorpusMatches(buildSearchCorpus(lines), normalizedQuery) : [];
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
