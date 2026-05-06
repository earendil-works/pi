/**
 * Copy-on-select extension.
 *
 * Replicates the Amp CLI behaviour: drag to select text in the terminal and
 * the selection is copied to the system clipboard on mouse release. Uses
 * SGR 1006 mouse reporting (enabled via the new `setMouseReporting`
 * primitive) and the existing `copyToClipboard` helper for OSC 52 / native
 * clipboard handoff.
 *
 * Caveat: enabling mouse reporting suppresses native terminal text selection
 * in most terminals. Shift-drag typically passes through to the terminal's
 * own selection in xterm/iTerm2/WezTerm/Kitty, so users retain a fallback.
 *
 * Setup:
 * - `pi -e ./examples/extensions/copy-on-select`
 * - or copy the directory into ~/.pi/agent/extensions/
 */

import { copyToClipboard, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface Point {
	x: number; // 1-indexed column
	y: number; // 1-indexed row
}

interface ParsedMouse {
	button: number;
	x: number;
	y: number;
	press: boolean;
	drag: boolean;
}

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

function parseMouse(data: string): ParsedMouse | undefined {
	const m = data.match(SGR_MOUSE);
	if (!m) return undefined;
	const button = Number(m[1]);
	return {
		button,
		x: Number(m[2]),
		y: Number(m[3]),
		press: m[4] === "M",
		drag: (button & 32) !== 0,
	};
}

function orderPoints(a: Point, b: Point): [Point, Point] {
	if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return [a, b];
	return [b, a];
}

function extractSelection(lines: string[], startPoint: Point, endPoint: Point): string {
	const [s, e] = orderPoints(startPoint, endPoint);
	const startRow = Math.max(0, s.y - 1);
	const endRow = Math.min(lines.length - 1, e.y - 1);
	if (startRow > endRow) return "";

	const startCol = Math.max(0, s.x - 1);
	const endCol = Math.max(0, e.x); // SGR x is the column the release landed on; slice end is exclusive

	if (startRow === endRow) {
		const line = lines[startRow] ?? "";
		return line.slice(startCol, endCol);
	}

	const firstLine = (lines[startRow] ?? "").slice(startCol);
	const middle = lines.slice(startRow + 1, endRow);
	const lastLine = (lines[endRow] ?? "").slice(0, endCol);
	return [firstLine, ...middle, lastLine].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-copy-on-select", {
		description: "Disable the copy-on-select extension",
		type: "boolean",
		default: false,
	});

	let unsubscribeInput: (() => void) | undefined;
	let active = false;
	let pressPoint: Point | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (pi.getFlag("no-copy-on-select") === true) return;

		ctx.ui.setMouseReporting(true);
		active = true;

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!active) return undefined;
			const mouse = parseMouse(data);
			if (!mouse) return undefined;

			// Only track the left mouse button (button code 0 with optional drag bit 32).
			const baseButton = mouse.button & 3;
			if (baseButton !== 0) return undefined;

			if (mouse.press && !mouse.drag) {
				pressPoint = { x: mouse.x, y: mouse.y };
			} else if (!mouse.press) {
				// Release: use the release coordinates as the selection end.
				const start = pressPoint;
				const end: Point = { x: mouse.x, y: mouse.y };
				pressPoint = undefined;

				if (!start) return undefined;
				if (start.x === end.x && start.y === end.y) return undefined;

				const text = extractSelection(ctx.ui.getRenderedLines(), start, end).trim();
				if (text.length > 0) {
					void copyToClipboard(text).catch(() => {
						// Clipboard write failed — silently ignore. The user has not
						// asked for status feedback on every drag.
					});
				}
			}

			// Don't consume — other extensions or future TUI mouse handling can still observe these.
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		if (unsubscribeInput) {
			unsubscribeInput();
			unsubscribeInput = undefined;
		}
		active = false;
		pressPoint = undefined;
	});
}
