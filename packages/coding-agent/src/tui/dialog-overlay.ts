import type { Component } from "@kennyfrc/mu-tui";
import { visibleWidth } from "@kennyfrc/mu-tui";
import { theme } from "../theme/theme.js";

function padStyled(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isHorizontalSeparatorLine(text: string): boolean {
	const visible = stripAnsi(text).trim();
	if (visible.length === 0) return false;
	return /^[─━═╌╍┄┅┈┉-]+$/.test(visible);
}

function trimEdgeSeparators(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && isHorizontalSeparatorLine(lines[start] ?? "")) {
		start++;
	}
	while (end > start && isHorizontalSeparatorLine(lines[end - 1] ?? "")) {
		end--;
	}

	return lines.slice(start, end);
}

interface DialogOverlayOptions {
	title: string;
	body: Component;
	focusTarget?: Component;
	onCancel?: () => void;
	panelWidth?: number;
	minPanelWidth?: number;
	maxPanelWidth?: number;
}

export class DialogOverlayComponent implements Component {
	private readonly title: string;
	private readonly body: Component;
	private readonly focusTarget: Component;
	private readonly onCancel?: () => void;
	private readonly panelWidth?: number;
	private readonly minPanelWidth?: number;
	private readonly maxPanelWidth?: number;

	constructor(options: DialogOverlayOptions) {
		this.title = options.title;
		this.body = options.body;
		this.focusTarget = options.focusTarget ?? options.body;
		this.onCancel = options.onCancel;
		this.panelWidth = options.panelWidth;
		this.minPanelWidth = options.minPanelWidth;
		this.maxPanelWidth = options.maxPanelWidth;
	}

	invalidate(): void {
		this.body.invalidate();
	}

	handleInput(data: string): void {
		if (data === "\x1b" && this.onCancel) {
			this.onCancel();
			return;
		}
		this.focusTarget.handleInput?.(data);
	}

	render(width: number): string[] {
		const backdrop = (text: string) => theme.bg("userMessageBg", text);
		const bg = (text: string) => theme.bg("userMessageBg", text);
		const border = (text: string) => theme.fg("borderMuted", text);
		const dim = (text: string) => theme.fg("muted", text);

		const maxPanelWidth = Math.max(24, Math.min(this.maxPanelWidth ?? Math.max(44, width - 8), width - 2));
		const minPanelWidth = Math.max(24, Math.min(this.minPanelWidth ?? 44, maxPanelWidth));
		const requestedPanelWidth = this.panelWidth ?? maxPanelWidth;
		const cardWidth = Math.max(minPanelWidth, Math.min(requestedPanelWidth, maxPanelWidth));
		const contentWidth = Math.max(1, cardWidth - 4);
		const cardOriginX = Math.max(0, Math.floor((width - cardWidth) / 2));
		const outerPadLeft = " ".repeat(cardOriginX);
		const outerPadRight = " ".repeat(Math.max(0, width - cardWidth - cardOriginX));

		const wrapFullWidth = (cardLine: string): string => backdrop(`${outerPadLeft}${cardLine}${outerPadRight}`);

		const wrapCardLine = (content: string): string => {
			const raw = `${border("│")} ${padStyled(content, contentWidth)} ${border("│")}`;
			return wrapFullWidth(bg(raw));
		};

		const title = theme.bold(theme.fg("muted", this.title));
		const titleFill = Math.max(0, cardWidth - 4 - visibleWidth(title));
		const topLine = wrapFullWidth(bg(`${border("╭─")} ${title}${border("─".repeat(titleFill))}${border("╮")}`));
		const bottomLine = wrapFullWidth(bg(`${border("╰")}${border("─".repeat(cardWidth - 2))}${border("╯")}`));

		const bodyLines = trimEdgeSeparators(this.body.render(contentWidth)).map((line) => wrapCardLine(line));
		const spacerLine = wrapCardLine("");
		const footerHint = "↑/↓ navigate • enter select • esc to close";
		const footerText = visibleWidth(footerHint) <= contentWidth ? footerHint : "enter select • esc to close";
		const footerLine = wrapCardLine(dim(footerText));

		return [topLine, spacerLine, ...bodyLines, spacerLine, footerLine, bottomLine];
	}
}
