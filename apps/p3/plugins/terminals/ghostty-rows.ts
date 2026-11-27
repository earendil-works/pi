// How the Ghostty screen (ghostty-screen.tsx) draws one row of the terminal into the page: runs of ASCII in one style
// as text (so selecting and copying are the browser's own), every other character in a box of its cells' width, and
// block elements as rectangles (fonts' glyphs for them leave gaps). Ported from p2's Terminal.tsx.

import { BOLD, type Cell, FAINT, INVERSE, INVISIBLE, ITALIC, OVERLINE, STRIKETHROUGH, UNDERLINE } from "./ghostty.ts";
import styles from "./ghostty-screen.module.css";

/** Draws one row: ASCII runs of one style as text, other characters in boxes of their cell width. */
export function drawRow(row: HTMLElement, cells: readonly Cell[], cellWidth: number): void {
	const fragment = document.createDocumentFragment();
	let run: HTMLSpanElement | undefined;
	let runKey = "";
	for (const cell of cells) {
		if (cell.width === 0) continue;
		let color = cell.fg === -1 ? "" : hex(cell.fg);
		let background = cell.bg === -1 ? "" : hex(cell.bg);
		if (cell.flags & INVERSE) {
			const foreground = color || "var(--term-fg)";
			color = background || "var(--term-bg)";
			background = foreground;
		}
		const text = cell.flags & INVISIBLE || !cell.text ? " " : cell.text;
		const style = cell.flags & (BOLD | ITALIC | FAINT | UNDERLINE | STRIKETHROUGH | OVERLINE);
		const key = `${color}|${background}|${style}`;
		const ascii = cell.width === 1 && text.length === 1 && text.charCodeAt(0) < 0x7f;
		if (ascii && run !== undefined && key === runKey) {
			run.textContent += text;
			continue;
		}
		const block = BLOCKS[text];
		const span = document.createElement("span");
		if (block !== undefined) {
			span.className = `${styles.cell} ${styles.block}`;
			span.style.width = `${cell.width * cellWidth}px`;
			const layers = blockBackground(block, color || "var(--term-fg)", cell.width * cellWidth);
			span.style.background = background ? `${layers}, ${background}` : layers;
			fragment.append(span);
			run = undefined;
			continue;
		}
		span.textContent = text;
		if (color) span.style.color = color;
		if (background) span.style.background = background;
		if (style & BOLD) span.style.fontWeight = "bold";
		if (style & ITALIC) span.style.fontStyle = "italic";
		if (style & FAINT) span.style.opacity = "0.6";
		const lines = [
			style & UNDERLINE ? "underline" : "",
			style & STRIKETHROUGH ? "line-through" : "",
			style & OVERLINE ? "overline" : "",
		]
			.filter((line) => line !== "")
			.join(" ");
		if (lines) span.style.textDecoration = lines;
		if (ascii) {
			run = span;
			runKey = key;
		} else {
			// Fallback fonts have other advances: every other character keeps to its cells.
			span.className = styles.cell ?? "";
			span.style.width = `${cell.width * cellWidth}px`;
			run = undefined;
		}
		fragment.append(span);
	}
	row.replaceChildren(fragment);
}

/**
 * Block elements (U+2580–U+259F) as rectangles of the cell in eighths, [left, top, right, bottom], or a shade's
 * opacity. Font glyphs for them stop short of the line box and come from fallback fonts with other metrics, so half
 * block art gets gaps; terminals draw these themselves.
 */
const BLOCKS: Readonly<Record<string, readonly (readonly [number, number, number, number])[] | number>> = {
	"▀": [[0, 0, 8, 4]],
	"▁": [[0, 7, 8, 8]],
	"▂": [[0, 6, 8, 8]],
	"▃": [[0, 5, 8, 8]],
	"▄": [[0, 4, 8, 8]],
	"▅": [[0, 3, 8, 8]],
	"▆": [[0, 2, 8, 8]],
	"▇": [[0, 1, 8, 8]],
	"█": [[0, 0, 8, 8]],
	"▉": [[0, 0, 7, 8]],
	"▊": [[0, 0, 6, 8]],
	"▋": [[0, 0, 5, 8]],
	"▌": [[0, 0, 4, 8]],
	"▍": [[0, 0, 3, 8]],
	"▎": [[0, 0, 2, 8]],
	"▏": [[0, 0, 1, 8]],
	"▐": [[4, 0, 8, 8]],
	"░": 0.25,
	"▒": 0.5,
	"▓": 0.75,
	"▔": [[0, 0, 8, 1]],
	"▕": [[7, 0, 8, 8]],
	"▖": [[0, 4, 4, 8]],
	"▗": [[4, 4, 8, 8]],
	"▘": [[0, 0, 4, 4]],
	"▙": [
		[0, 0, 4, 8],
		[4, 4, 8, 8],
	],
	"▚": [
		[0, 0, 4, 4],
		[4, 4, 8, 8],
	],
	"▛": [
		[0, 0, 8, 4],
		[0, 4, 4, 8],
	],
	"▜": [
		[0, 0, 8, 4],
		[4, 4, 8, 8],
	],
	"▝": [[4, 0, 8, 4]],
	"▞": [
		[4, 0, 8, 4],
		[0, 4, 4, 8],
	],
	"▟": [
		[4, 0, 8, 8],
		[0, 4, 4, 8],
	],
};

/** CSS background layers that draw a block element in `color` over a cell `cellWidth` pixels wide. */
function blockBackground(block: (typeof BLOCKS)[string], color: string, cellWidth: number): string {
	if (typeof block === "number") {
		const shade = `color-mix(in srgb, ${color} ${block * 100}%, transparent)`;
		return `linear-gradient(${shade}, ${shade})`;
	}
	return block
		.map(([left, top, right, bottom]) => {
			const x = `${(left / 8) * cellWidth}px`;
			const y = `calc(var(--cell-height) * ${top / 8})`;
			const width = `${((right - left) / 8) * cellWidth}px`;
			const height = `calc(var(--cell-height) * ${(bottom - top) / 8})`;
			return `linear-gradient(${color}, ${color}) ${x} ${y} / ${width} ${height} no-repeat`;
		})
		.join(", ");
}

/** A colour 0xRRGGBB as CSS. */
export function hex(color: number): string {
	return `#${color.toString(16).padStart(6, "0")}`;
}
