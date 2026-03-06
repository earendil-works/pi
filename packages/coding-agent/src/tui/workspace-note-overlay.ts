import { homedir } from "node:os";
import { type Component, Editor, visibleWidth } from "@kennyfrc/mu-tui";
import { getEditorTheme, theme } from "../theme/theme.js";

interface WorkspaceNoteOverlayOptions {
	tui: WorkspaceNoteOverlayScheduler;
	workspaceLabel: string;
	initialText: string;
	onSave: (text: string) => void;
	onCancel: () => void;
}

export interface WorkspaceNoteOverlayScheduler {
	requestRender(): void;
}

const segmenter = new Intl.Segmenter();

function padStyled(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function truncatePlainTextMiddle(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 1) return "…";

	const parts = Array.from(segmenter.segment(text), (part) => part.segment);
	const ellipsis = "…";
	const targetWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));

	let left = "";
	let leftWidth = 0;
	let leftIndex = 0;
	while (leftIndex < parts.length) {
		const next = parts[leftIndex] ?? "";
		const nextWidth = visibleWidth(next);
		if (leftWidth + nextWidth > Math.ceil(targetWidth / 2)) break;
		left += next;
		leftWidth += nextWidth;
		leftIndex++;
	}

	let right = "";
	let rightWidth = 0;
	let rightIndex = parts.length - 1;
	while (rightIndex >= leftIndex) {
		const next = parts[rightIndex] ?? "";
		const nextWidth = visibleWidth(next);
		if (leftWidth + rightWidth + nextWidth > targetWidth) break;
		right = next + right;
		rightWidth += nextWidth;
		rightIndex--;
	}

	return left + ellipsis + right;
}

function shortenWorkspaceLabel(path: string, maxWidth: number): string {
	const home = homedir();
	const displayPath = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	return truncatePlainTextMiddle(displayPath, maxWidth);
}

export class WorkspaceNoteOverlayComponent implements Component {
	private readonly tui: WorkspaceNoteOverlayScheduler;
	private readonly workspaceLabel: string;
	private readonly onSave: (text: string) => void;
	private readonly onCancel: () => void;
	private readonly editor: Editor;

	constructor(options: WorkspaceNoteOverlayOptions) {
		this.tui = options.tui;
		this.workspaceLabel = options.workspaceLabel;
		this.onSave = options.onSave;
		this.onCancel = options.onCancel;

		this.editor = new Editor(getEditorTheme());
		this.editor.borderColor = (text: string) => theme.fg("borderAccent", text);
		this.editor.maxHeight = 8;
		this.editor.setText(options.initialText);
		this.editor.onSubmit = (text) => {
			this.onSave(text);
			this.tui.requestRender();
		};
	}

	setText(text: string): void {
		this.editor.setText(text);
	}

	getText(): string {
		return this.editor.getText();
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	render(width: number): string[] {
		const shadowWidth = 2;
		const cardWidth = Math.max(44, width - shadowWidth);
		const contentWidth = Math.max(1, cardWidth - 4);
		const bg = (text: string) => theme.bg("userMessageBg", text);
		const sideBorder = (text: string) => theme.fg("borderMuted", text);
		const topBorder = (text: string) => theme.fg("borderAccent", text);
		const bottomBorder = (text: string) => theme.fg("borderMuted", text);
		const shadow = theme.fg("dim", " ░");

		const wrapCardLine = (content: string): string => {
			const raw = `${sideBorder("│")} ${padStyled(content, contentWidth)} ${sideBorder("│")}`;
			return bg(raw) + shadow;
		};

		const title = theme.fg("accent", "✦") + " " + theme.bold("Workspace note");
		const titleFill = Math.max(0, cardWidth - 4 - visibleWidth(title));
		const topLine = bg(`${topBorder("╭─")} ${title}${topBorder("─".repeat(titleFill))}${topBorder("╮")}`) + shadow;

		const workspacePrefix = theme.fg("dim", "persistent per repo") + theme.fg("muted", "  •  ");
		const workspacePathWidth = Math.max(8, contentWidth - visibleWidth(workspacePrefix));
		const workspaceLine = workspacePrefix + shortenWorkspaceLabel(this.workspaceLabel, workspacePathWidth);

		const editorLines = this.editor.render(contentWidth);
		const footerLine =
			theme.fg("accent", "Enter") +
			theme.fg("muted", " save") +
			theme.fg("dim", "  •  ") +
			theme.fg("accent", "Shift+Enter") +
			theme.fg("muted", " newline") +
			theme.fg("dim", "  •  ") +
			theme.fg("accent", "Esc") +
			theme.fg("muted", " cancel");
		const divider = bg(`${bottomBorder("├")}${bottomBorder("─".repeat(cardWidth - 2))}${bottomBorder("┤")}`) + shadow;
		const bottomLine =
			bg(`${bottomBorder("╰")}${bottomBorder("─".repeat(cardWidth - 2))}${bottomBorder("╯")}`) + shadow;
		const bottomShadow = " ".repeat(2) + theme.fg("dim", "░".repeat(Math.max(1, cardWidth)));

		return [
			topLine,
			wrapCardLine(workspaceLine),
			wrapCardLine(""),
			...editorLines.map((line) => wrapCardLine(line)),
			wrapCardLine(""),
			divider,
			wrapCardLine(footerLine),
			bottomLine,
			bottomShadow,
		];
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			this.onCancel();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
	}
}
