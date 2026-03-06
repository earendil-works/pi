/**
 * Minimal TUI implementation with differential rendering
 */

import type { Terminal } from "./terminal.js";
import { visibleWidth } from "./utils.js";

export type { Terminal };

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

export { visibleWidth };

export type RenderReason = "input" | "resize" | "stream" | "tool_progress" | "other";

export interface RenderThrottleConfig {
	/**
	 * Minimum time between renders for streaming assistant deltas.
	 * Smaller = smoother streaming, higher CPU. Larger = fewer renders, less CPU.
	 */
	streamMinIntervalMs?: number;
	/**
	 * Minimum time between renders for tool progress output (e.g. bash stdout/stderr streaming).
	 */
	toolProgressMinIntervalMs?: number;
}

export interface OverlayOptions {
	width?: number;
	minWidth?: number;
	maxWidth?: number;
	marginX?: number;
}

interface ActiveOverlay {
	component: Component;
	options: OverlayOptions;
}

interface AnsiExtractResult {
	code: string;
	length: number;
}

class AnsiStateTracker {
	private activeSgrCodes: string[] = [];

	process(code: string): void {
		if (!code.endsWith("m")) return;
		if (code === "\x1b[0m" || code === "\x1b[m") {
			this.activeSgrCodes = [];
			return;
		}
		this.activeSgrCodes.push(code);
	}

	getActiveCodes(): string {
		return this.activeSgrCodes.join("");
	}

	hasActiveCodes(): boolean {
		return this.activeSgrCodes.length > 0;
	}
}

const ansiSegmenter = new Intl.Segmenter();

function extractAnsiCode(str: string, pos: number): AnsiExtractResult | null {
	if (pos >= str.length || str[pos] !== "\x1b" || str[pos + 1] !== "[") {
		return null;
	}

	let j = pos + 2;
	while (j < str.length && str[j] && !/[mGKHJ]/.test(str[j]!)) {
		j++;
	}

	if (j < str.length) {
		return {
			code: str.substring(pos, j + 1),
			length: j + 1 - pos,
		};
	}

	return null;
}

function splitVisibleSegments(text: string): Array<{ type: "ansi" | "grapheme"; value: string }> {
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];
	let i = 0;

	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			segments.push({ type: "ansi", value: ansi.code });
			i += ansi.length;
			continue;
		}

		let end = i;
		while (end < text.length && !extractAnsiCode(text, end)) {
			end++;
		}

		for (const seg of ansiSegmenter.segment(text.slice(i, end))) {
			segments.push({ type: "grapheme", value: seg.segment });
		}
		i = end;
	}

	return segments;
}

function sliceAnsiByVisibleWidth(text: string, start: number, end: number): string {
	if (end <= start) return "";

	const tracker = new AnsiStateTracker();
	let result = "";
	let visiblePos = 0;
	let started = false;

	for (const segment of splitVisibleSegments(text)) {
		if (segment.type === "ansi") {
			tracker.process(segment.value);
			if (started) {
				result += segment.value;
			}
			continue;
		}

		const graphemeWidth = visibleWidth(segment.value);
		const nextVisiblePos = visiblePos + graphemeWidth;

		if (nextVisiblePos <= start) {
			visiblePos = nextVisiblePos;
			continue;
		}

		if (visiblePos >= end) {
			break;
		}

		if (!started) {
			started = true;
			if (tracker.hasActiveCodes()) {
				result += tracker.getActiveCodes();
			}
		}

		result += segment.value;
		visiblePos = nextVisiblePos;

		if (visiblePos >= end) {
			break;
		}
	}

	if (!started) return "";
	if (tracker.hasActiveCodes()) {
		result += "\x1b[0m";
	}
	return result;
}

function padAnsiToWidth(text: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(padding);
}

function overlayLine(
	baseLine: string,
	overlayText: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const paddedBase = padAnsiToWidth(baseLine, totalWidth);
	const left = sliceAnsiByVisibleWidth(paddedBase, 0, startCol);
	const right = sliceAnsiByVisibleWidth(paddedBase, startCol + overlayWidth, totalWidth);
	const paddedOverlay = padAnsiToWidth(overlayText, overlayWidth);
	return left + paddedOverlay + right;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	private terminal: Terminal;
	private overlay: ActiveOverlay | null = null;
	private previousLines: string[] = [];
	private previousWidth = 0;
	private focusedComponent: Component | null = null;
	private renderRequested = false;
	private resizeBaselineDirty = false;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row after last write
	private maxLinesRendered = 0; // Max number of lines ever rendered (working area)
	private previousViewportTop = 0; // Previous viewport top (0-indexed, in content-space)

	private streamMinIntervalMs: number;
	private toolProgressMinIntervalMs: number;

	private throttleTimer: NodeJS.Timeout | null = null;
	private throttleNeedsRender = false;
	private throttleNextIntervalMs = 0;

	constructor(terminal: Terminal, throttleConfig: RenderThrottleConfig = {}) {
		super();
		this.terminal = terminal;
		this.streamMinIntervalMs = throttleConfig.streamMinIntervalMs ?? 33;
		this.toolProgressMinIntervalMs = throttleConfig.toolProgressMinIntervalMs ?? 33;
	}

	setFocus(component: Component | null): void {
		this.focusedComponent = component;
	}

	setOverlay(component: Component | null, options: OverlayOptions = {}): void {
		this.overlay = component ? { component, options } : null;
	}

	clearOverlay(): void {
		this.overlay = null;
	}

	override invalidate(): void {
		super.invalidate();
		this.overlay?.component.invalidate();
	}

	override render(width: number): string[] {
		const baseLines = super.render(width);
		return this.composeOverlay(baseLines, width, this.terminal.rows);
	}

	private composeOverlay(baseLines: string[], width: number, height: number): string[] {
		if (!this.overlay) {
			return baseLines;
		}

		const marginX = Math.max(0, this.overlay.options.marginX ?? 4);
		const availableWidth = Math.max(1, width - marginX * 2);
		const maxWidth = Math.max(1, Math.min(this.overlay.options.maxWidth ?? availableWidth, availableWidth));
		const minWidth = Math.max(1, Math.min(this.overlay.options.minWidth ?? Math.min(72, maxWidth), maxWidth));
		const overlayWidth = Math.max(1, Math.min(this.overlay.options.width ?? maxWidth, maxWidth));
		const dialogWidth = Math.max(minWidth, overlayWidth);
		const renderedOverlay = this.overlay.component.render(dialogWidth);
		const croppedOverlay = renderedOverlay.slice(0, height);

		const frameLines = baseLines.slice();
		const frameHeight = Math.max(frameLines.length, height);
		while (frameLines.length < frameHeight) {
			frameLines.push("");
		}

		const viewportTop = Math.max(0, frameLines.length - height);
		const originX = Math.max(0, Math.floor((width - dialogWidth) / 2));
		const originY = viewportTop + Math.max(0, Math.floor((height - croppedOverlay.length) / 2));

		for (let i = 0; i < croppedOverlay.length; i++) {
			const lineIndex = originY + i;
			const baseLine = frameLines[lineIndex] ?? "";
			frameLines[lineIndex] = overlayLine(baseLine, croppedOverlay[i] ?? "", originX, dialogWidth, width);
		}

		return frameLines;
	}

	start(): void {
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRenderWithReason("resize"),
		);
		this.terminal.hideCursor();
		this.requestRender();
	}

	stop(): void {
		// Try to move the cursor below our rendered content so the shell prompt
		// doesn't overwrite UI content on exit.
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // line after last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				// Use real newlines so the terminal scrolls if needed.
				this.terminal.write("\r\n".repeat(lineDiff));
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A\r\n`);
			} else {
				this.terminal.write("\r\n");
			}
		}
		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(): void {
		this.requestRenderWithReason("other");
	}

	requestRenderWithReason(reason: RenderReason): void {
		if (reason === "stream") {
			this.requestThrottledRender(this.streamMinIntervalMs);
			return;
		}
		if (reason === "tool_progress") {
			this.requestThrottledRender(this.toolProgressMinIntervalMs);
			return;
		}
		if (reason === "resize") {
			// A terminal resize can reflow the physical screen even if the final width
			// ends up matching the last committed render width. In that case our
			// previousLines/previousWidth baseline is no longer trustworthy.
			this.resizeBaselineDirty = true;
		}

		// Input/resize/other should render immediately and also cancel any pending throttle
		// so streaming can resume at full cadence afterwards.
		this.cancelThrottle();
		this.requestImmediateRender();
	}

	private requestImmediateRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => {
			this.renderRequested = false;
			this.doRender();
		});
	}

	private requestThrottledRender(minIntervalMs: number): void {
		if (!this.throttleTimer) {
			// First event in the window: render immediately for responsiveness.
			this.requestImmediateRender();
			this.startThrottleWindow(minIntervalMs);
			return;
		}

		// In the window: request a trailing-edge render.
		this.throttleNeedsRender = true;
		this.throttleNextIntervalMs = this.throttleNextIntervalMs
			? Math.min(this.throttleNextIntervalMs, minIntervalMs)
			: minIntervalMs;
	}

	private startThrottleWindow(minIntervalMs: number): void {
		this.throttleTimer = setTimeout(() => {
			this.throttleTimer = null;

			if (!this.throttleNeedsRender) return;

			const nextIntervalMs = this.throttleNextIntervalMs || minIntervalMs;
			this.throttleNeedsRender = false;
			this.throttleNextIntervalMs = 0;

			this.requestImmediateRender();
			this.startThrottleWindow(nextIntervalMs);
		}, minIntervalMs);
	}

	private cancelThrottle(): void {
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = null;
		}
		this.throttleNeedsRender = false;
		this.throttleNextIntervalMs = 0;
	}

	private handleInput(data: string): void {
		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			this.focusedComponent.handleInput(data);
			this.requestRenderWithReason("input");
		}
	}

	private doRender(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Render all components to get new lines
		const newLines = this.render(width);

		// Width changed - need full re-render
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;

		const fullRender = (clear: boolean): void => {
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);

			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;

			// Reset working area on clear, otherwise track growth.
			this.maxLinesRendered = clear ? newLines.length : Math.max(this.maxLinesRendered, newLines.length);
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);

			this.previousLines = newLines;
			this.previousWidth = width;
			this.resizeBaselineDirty = false;
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged) {
			fullRender(false);
			return;
		}

		// Width changed - full re-render
		if (widthChanged) {
			fullRender(true);
			return;
		}

		if (this.resizeBaselineDirty) {
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}

		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}

		// No changes
		if (firstChanged === -1) {
			return;
		}

		// If content shrunk, do a full redraw to avoid leaving stale lines on screen.
		// (This is rare in normal streaming workloads and keeps the implementation safe.)
		if (this.previousLines.length > newLines.length) {
			fullRender(true);
			return;
		}

		// All changes are in deleted lines. For correctness (and simplicity), do a full redraw.
		if (firstChanged >= newLines.length) {
			fullRender(true);
			return;
		}

		// Special case: appended lines must be committed to scrollback.
		// Terminals generally do NOT scroll when you "move down" with cursor controls.
		// They scroll when you actually output newlines at the bottom.
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// Check if firstChanged is above what was previously visible.
		// We use previousLines.length here (not maxLinesRendered) to avoid false positives after shrink.
		const previousContentViewportTop = Math.max(0, this.previousLines.length - height);
		if (firstChanged < previousContentViewportTop) {
			// First change is above viewport - need full re-render
			fullRender(true);
			return;
		}

		// Render only the changed range (firstChanged..lastChanged), not all lines to end.
		let buffer = "\x1b[?2026h"; // Begin synchronized output

		let prevViewportTop = this.previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;

		const workingHeight = Math.max(this.maxLinesRendered, this.previousLines.length, newLines.length);
		let viewportTop = Math.max(0, workingHeight - height);

		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;

		// If the target is below the currently visible viewport bottom, scroll by emitting newlines.
		// This is necessary because cursor-down escape sequences generally do not scroll.
		const prevViewportBottom = prevViewportTop + height - 1;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}

			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const targetScreenRow = Math.max(0, Math.min(height - 1, targetRow - prevViewportTop));
			return targetScreenRow - currentScreenRow;
		};

		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0 (and scroll if appending)

		const renderEnd = Math.min(lastChanged, newLines.length - 1);

		// Render changed lines, clearing each line before writing.
		// This avoids the \x1b[J clear-to-end which can cause flicker in xterm.js
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) {
				buffer += "\r\n";
			}
			buffer += "\x1b[2K"; // Clear current line
			if (visibleWidth(newLines[i]) > width) {
				throw new Error(`Rendered line ${i} exceeds terminal width\n\n${newLines[i]}`);
			}
			buffer += newLines[i];
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor positions for next render.
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = renderEnd;
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
		this.previousLines = newLines;
		this.previousWidth = width;
	}
}
