import type { TuiMouseEvent } from "../mouse.ts";
import type { Component } from "../tui.ts";

export interface ViewportOptions {
	content: Component;
	fixed: Component;
	getHeight: () => number;
	scrollStep?: number;
}

/**
 * Keeps one region fixed at the bottom while exposing a scrollable viewport
 * over the preceding content.
 */
export class Viewport implements Component {
	private readonly content: Component;
	private readonly fixed: Component;
	private readonly getHeight: () => number;
	private readonly scrollStep: number;
	private viewportStart = 0;
	private followBottom = true;
	private lastContentLength = 0;
	private lastHistoryHeight = 0;
	private lastFixedOffset = 0;

	constructor(options: ViewportOptions) {
		this.content = options.content;
		this.fixed = options.fixed;
		this.getHeight = options.getHeight;
		this.scrollStep = Math.max(1, Math.floor(options.scrollStep ?? 3));
	}

	render(width: number): string[] {
		const height = Math.max(1, Math.floor(this.getHeight()));
		const fixedLines = this.fixed.render(width);
		if (fixedLines.length >= height) {
			this.lastContentLength = 0;
			this.lastHistoryHeight = 0;
			this.lastFixedOffset = fixedLines.length - height;
			return fixedLines.slice(-height);
		}

		const contentLines = this.content.render(width);
		const historyHeight = height - fixedLines.length;
		const maxStart = Math.max(0, contentLines.length - historyHeight);
		this.viewportStart = this.followBottom ? maxStart : Math.min(this.viewportStart, maxStart);
		this.lastContentLength = contentLines.length;
		this.lastHistoryHeight = historyHeight;
		this.lastFixedOffset = 0;

		const visible = contentLines.slice(this.viewportStart, this.viewportStart + historyHeight);
		while (visible.length < historyHeight) visible.push("");
		return [...visible, ...fixedLines];
	}

	handleMouse(event: TuiMouseEvent): boolean {
		if (event.type === "wheel") {
			const maxStart = Math.max(0, this.lastContentLength - this.lastHistoryHeight);
			if (event.direction === "up") {
				if (this.followBottom) this.viewportStart = maxStart;
				this.followBottom = false;
				this.viewportStart = Math.max(0, this.viewportStart - this.scrollStep);
			} else {
				this.viewportStart = Math.min(maxStart, this.viewportStart + this.scrollStep);
				this.followBottom = this.viewportStart >= maxStart;
			}
			return true;
		}

		if (event.y < this.lastHistoryHeight) {
			return this.content.handleMouse?.({ ...event, y: event.y + this.viewportStart }) ?? false;
		}
		return (
			this.fixed.handleMouse?.({
				...event,
				y: event.y - this.lastHistoryHeight + this.lastFixedOffset,
			}) ?? false
		);
	}

	scrollToBottom(): void {
		this.followBottom = true;
	}

	invalidate(): void {
		this.content.invalidate();
		this.fixed.invalidate();
	}
}
