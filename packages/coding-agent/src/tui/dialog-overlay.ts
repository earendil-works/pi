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
}

export class DialogOverlayComponent implements Component {
	private readonly title: string;
	private readonly body: Component;
	private readonly focusTarget: Component;
	private readonly onCancel?: () => void;

	constructor(options: DialogOverlayOptions) {
		this.title = options.title;
		this.body = options.body;
		this.focusTarget = options.focusTarget ?? options.body;
		this.onCancel = options.onCancel;
	}

	invalidate(): void {
		this.body.invalidate();
	}

	handleInput(data: string): void {
		if (data === "\x03" && this.onCancel) {
			this.onCancel();
			return;
		}
		this.focusTarget.handleInput?.(data);
	}

	render(width: number): string[] {
		const cardWidth = Math.max(44, width);
		const contentWidth = Math.max(1, cardWidth - 4);
		const bg = (text: string) => theme.bg("userMessageBg", text);
		const border = (text: string) => theme.fg("borderMuted", text);

		const wrapCardLine = (content: string): string => {
			const raw = `${border("│")} ${padStyled(content, contentWidth)} ${border("│")}`;
			return bg(raw);
		};

		const title = theme.bold(theme.fg("muted", this.title));
		const titleFill = Math.max(0, cardWidth - 4 - visibleWidth(title));
		const topLine = bg(`${border("╭─")} ${title}${border("─".repeat(titleFill))}${border("╮")}`);
		const bottomLine = bg(`${border("╰")}${border("─".repeat(cardWidth - 2))}${border("╯")}`);

		const bodyLines = trimEdgeSeparators(this.body.render(contentWidth)).map((line) => wrapCardLine(line));

		return [topLine, ...bodyLines, bottomLine];
	}
}
