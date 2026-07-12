import { getGraphemeSegmenter, visibleWidth } from "../utils.ts";
import type { Cell, LinkTable } from "./cell-buffer.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine, type StyleTable, type TerminalColor, type TextStyle } from "./styles.ts";

const RESET = "\x1b[0m";

function colorParams(color: TerminalColor, foreground: boolean): string[] {
	switch (color.kind) {
		case "default":
			return [foreground ? "39" : "49"];
		case "indexed": {
			const index = color.index;
			if (index < 8) return [String((foreground ? 30 : 40) + index)];
			if (index < 16) return [String((foreground ? 90 : 100) + (index - 8))];
			return [foreground ? "38" : "48", "5", String(index)];
		}
		case "rgb":
			return [foreground ? "38" : "48", "2", String(color.red), String(color.green), String(color.blue)];
	}
}

/** SGR attribute+color params for a style, excluding the leading reset. */
export function styleParams(style: TextStyle): string[] {
	const params: string[] = [];
	if (style.bold) params.push("1");
	if (style.dim) params.push("2");
	if (style.italic) params.push("3");
	if (style.underline) params.push("4");
	if (style.blink) params.push("5");
	if (style.inverse) params.push("7");
	if (style.hidden) params.push("8");
	if (style.strikethrough) params.push("9");
	if (style.foreground.kind !== "default") params.push(...colorParams(style.foreground, true));
	if (style.background.kind !== "default") params.push(...colorParams(style.background, false));
	return params;
}

/** Reset-then-set SGR sequence for a style. Always resets first so no prior attribute leaks in. */
export function styleToSgr(style: TextStyle): string {
	const params = styleParams(style);
	return params.length === 0 ? RESET : `\x1b[0;${params.join(";")}m`;
}

export function openLink(url: string): string {
	return `\x1b]8;;${url}\x07`;
}

export function closeLink(): string {
	return "\x1b]8;;\x07";
}

/** Serialize a styled line to a self-contained ANSI string (resets attributes and closes links at the end). */
export function styledLineToAnsi(line: StyledLine): string {
	let out = "";
	let openedLink = false;
	for (const span of line) {
		if (span.text.length === 0) continue;
		out += styleToSgr(span.style);
		if (span.link) {
			out += openLink(span.link);
			openedLink = true;
		}
		out += span.text;
		if (span.link) {
			out += closeLink();
			openedLink = false;
		}
	}
	if (openedLink) out += closeLink();
	return out + RESET;
}

/** Serialize a contiguous run of cells (skipping wide-glyph continuations) to a minimal-transition ANSI string. */
export function cellsToAnsi(cells: readonly Cell[], styles: StyleTable, links: LinkTable): string {
	let out = "";
	let currentStyleId = 0;
	let currentLinkId = 0;
	let emittedStyle = false;
	for (const cell of cells) {
		if (cell.cluster === "") continue; // wide-glyph continuation column
		if (!emittedStyle || cell.styleId !== currentStyleId) {
			out += styleToSgr(styles.get(cell.styleId));
			currentStyleId = cell.styleId;
			emittedStyle = true;
		}
		if (cell.linkId !== currentLinkId) {
			if (currentLinkId !== 0) out += closeLink();
			const url = links.get(cell.linkId);
			if (url) out += openLink(url);
			currentLinkId = cell.linkId;
		}
		out += cell.cluster;
	}
	if (currentLinkId !== 0) out += closeLink();
	return out + RESET;
}

/** Split one styled line into visual lines no wider than `width`, preserving span styles/links. */
export function hardWrapStyledLine(line: StyledLine, width: number): StyledLine[] {
	const maxWidth = Math.max(1, Math.trunc(Number.isFinite(width) ? width : 1));
	const rows: StyledLine[] = [];
	let current: StyledLine = [];
	let currentWidth = 0;
	const pushRow = (): void => {
		rows.push(current);
		current = [];
		currentWidth = 0;
	};
	for (const span of line) {
		if (span.text.length === 0) continue;
		let pending = "";
		const flushPending = (): void => {
			if (pending.length === 0) return;
			current.push(
				span.link === undefined
					? { text: pending, style: span.style }
					: { text: pending, style: span.style, link: span.link },
			);
			pending = "";
		};
		for (const segment of getGraphemeSegmenter().segment(span.text)) {
			const cluster = segment.segment;
			const clusterWidth = visibleWidth(cluster);
			if (currentWidth > 0 && currentWidth + clusterWidth > maxWidth) {
				flushPending();
				pushRow();
			}
			pending += cluster;
			currentWidth += clusterWidth;
		}
		flushPending();
	}
	if (current.length > 0 || rows.length === 0) rows.push(current);
	return rows;
}

export { DEFAULT_TEXT_STYLE };
