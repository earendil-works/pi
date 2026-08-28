import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}

export type DiffRowKind = "context" | "removed" | "added";

export interface DiffRow {
	kind: DiffRowKind;
	lineNum: string;
	content: string;
}

export const BODY_JOINT = "└ ";
export const BODY_JOINT_WIDTH = 2;

export function parseDiffRows(diffText: string): { rows: DiffRow[]; added: number; removed: number } {
	const rows: DiffRow[] = [];
	let added = 0;
	let removed = 0;

	for (const line of diffText.split("\n")) {
		const parsed = parseDiffLine(line);
		if (!parsed) continue;

		const kind: DiffRowKind = parsed.prefix === "+" ? "added" : parsed.prefix === "-" ? "removed" : "context";
		if (kind === "added") added++;
		if (kind === "removed") removed++;
		rows.push({ kind, lineNum: parsed.lineNum.trim(), content: parsed.content });
	}

	return { rows, added, removed };
}

export class DiffRowsComponent implements Component {
	private readonly rows: DiffRow[];
	private readonly highlightedContents?: string[];

	constructor(rows: DiffRow[], filePath?: string) {
		this.rows = rows;
		const lang = filePath ? getLanguageFromPath(filePath) : undefined;
		if (lang) {
			this.highlightedContents = highlightCode(rows.map((row) => replaceTabs(row.content)).join("\n"), lang);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const numWidth = Math.max(1, ...this.rows.map((row) => row.lineNum.length));
		const indentWidth = Math.min(BODY_JOINT_WIDTH, Math.max(0, width));
		const regionWidth = Math.max(0, width - indentWidth);
		const indent = " ".repeat(indentWidth);

		return this.rows.map((row, index) => {
			if (regionWidth === 0) return indent;

			const marker = row.kind === "context" ? "  " : row.kind === "removed" ? " -" : " +";
			const color = row.kind === "context" ? "toolDiffContext" : "toolDiffText";
			const prefix = theme.fg(color, `${row.lineNum.padStart(numWidth, " ")}${marker}`);
			const content = this.highlightedContents?.[index] ?? theme.fg(color, replaceTabs(row.content));
			const styled = truncateToWidth(prefix + content, regionWidth, "");
			const padded = styled + " ".repeat(regionWidth - visibleWidth(styled));
			if (row.kind === "context") return indent + padded;

			return indent + theme.bg(row.kind === "removed" ? "toolDiffRemovedBg" : "toolDiffAddedBg", padded);
		});
	}
}
