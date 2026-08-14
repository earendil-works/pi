import { Input } from "./components/input.ts";
import type { Component, Focusable } from "./tui.ts";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	row: number;
	startCol: number;
	endCol: number;
}

const MAX_SEARCH_MATCHES = 20_000;

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function prefixTable(pattern: string): number[] {
	const table = new Array<number>(pattern.length).fill(0);
	for (let index = 1, prefix = 0; index < pattern.length; index++) {
		while (prefix > 0 && pattern[index] !== pattern[prefix]) prefix = table[prefix - 1] ?? 0;
		if (pattern[index] === pattern[prefix]) prefix += 1;
		table[index] = prefix;
	}
	return table;
}

/** Search normalized transcript rows with memory bounded by query size and retained matches. */
export function findAltScreenSearchMatchesInRows(
	rowCount: number,
	lineAt: (row: number) => string | undefined,
	query: string,
): AltScreenSearchMatch[] {
	const pattern = normalizeQuery(query);
	if (!pattern) return [];
	const table = prefixTable(pattern);
	const sourceRing = new Array<SearchSourceSpan | undefined>(pattern.length);
	const matches: AltScreenSearchMatch[] = [];
	let matched = 0;
	let position = -1;
	let emittedText = false;
	let pendingSeparator = false;

	const emit = (text: string, span: SearchSourceSpan | undefined): boolean => {
		for (let index = 0; index < text.length; index++) {
			position += 1;
			const character = text[index]!;
			sourceRing[position % pattern.length] = span;
			while (matched > 0 && character !== pattern[matched]) matched = table[matched - 1] ?? 0;
			if (character === pattern[matched]) matched += 1;
			if (matched !== pattern.length) continue;
			const segments: AltScreenSearchSegment[] = [];
			for (let sourcePosition = position - pattern.length + 1; sourcePosition <= position; sourcePosition++) {
				const source = sourceRing[sourcePosition % pattern.length];
				if (!source) continue;
				const previous = segments[segments.length - 1];
				if (previous && previous.row === source.row && source.startCol <= previous.endCol) {
					previous.endCol = Math.max(previous.endCol, source.endCol);
				} else {
					segments.push({ ...source });
				}
			}
			if (segments.length > 0) matches.push({ segments });
			matched = 0;
			if (matches.length >= MAX_SEARCH_MATCHES) return false;
		}
		return true;
	};

	for (let row = 0; row < rowCount; row++) {
		const line = stripTerminalSequences(lineAt(row) ?? "");
		let column = 0;
		for (const grapheme of segmenter.segment(line)) {
			const text = grapheme.segment;
			const width = visibleWidth(text);
			if (/^\s+$/u.test(text)) {
				if (emittedText) pendingSeparator = true;
				column += width;
				continue;
			}
			if (pendingSeparator) {
				if (!emit(" ", undefined)) return matches;
				pendingSeparator = false;
			}
			if (!emit(text.toLocaleLowerCase(), { row, startCol: column, endCol: column + width })) return matches;
			emittedText = true;
			column += width;
		}
		if (emittedText) pendingSeparator = true;
	}
	return matches;
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	return findAltScreenSearchMatchesInRows(lines.length, (row) => lines[row], query);
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export class AltScreenSearchComponent implements Component, Focusable {
	private readonly input = new Input();
	private readonly onQueryChange: (query: string) => void;
	private resultCount = 0;
	private resultIndex = -1;
	private _focused = false;

	constructor(onQueryChange: (query: string) => void) {
		this.onQueryChange = onQueryChange;
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
		const label = " Find transcript";
		const query = this.input.getValue();
		const status = !query
			? ""
			: this.resultCount === 0
				? "No matches "
				: `${this.resultIndex + 1}/${this.resultCount} `;
		const labelWidth = visibleWidth(label);
		const statusWidth = visibleWidth(status);
		const gap = " ".repeat(Math.max(1, safeWidth - labelWidth - statusWidth));
		const title = truncateToWidth(`${label}${gap}${status}`, safeWidth, "");
		const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(title)));
		return [`\x1b[7m${title}${padding}\x1b[27m`, ...this.input.render(safeWidth)];
	}
}
