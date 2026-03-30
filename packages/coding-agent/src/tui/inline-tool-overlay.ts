import { Container, visibleWidth } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import { readMuDisplayV1 } from "../display/mu-display.js";
import { theme } from "../theme/theme.js";

// Maximum lines to show when collapsed
const DEFAULT_MAX_LINES = 3;

interface TodoOverlayItem {
	content: string;
	status: "pending" | "in_progress" | "blocked";
	priority?: "high" | "medium" | "low";
}

interface TodoOverlayLine {
	kind: "todo" | "text";
	text: string;
	status?: "pending" | "in_progress" | "blocked";
	priority?: "high" | "medium" | "low";
}

function padStyled(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Component that renders a tool call in a compact inline format
 * for display above the composer (not in scrollable chat history).
 */
export class InlineToolOverlayComponent extends Container {
	private expanded = false;
	private hidden = false;
	private dismissed = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: unknown;
	};

	constructor(toolName: string, args: unknown) {
		super();
		void toolName;
		void args;
	}

	updateResult(result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: unknown;
	}): void {
		this.result = result;
		this.hidden = false;
		if (this.shouldAutoDismiss(result.details)) {
			this.dismiss();
			return;
		}
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.rebuild();
	}

	dismiss(): void {
		this.dismissed = true;
		this.clear();
	}

	isDismissed(): boolean {
		return this.dismissed;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}

	toggleHidden(): void {
		this.hidden = !this.hidden;
	}

	isHidden(): boolean {
		return this.hidden;
	}

	private rebuild(): void {
		this.clear();
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c) => c.type === "text") || [];
		let output = textBlocks.map((c) => stripAnsi(c.text || "").replace(/\r/g, "")).join("\n");

		// Strip system_reminder tags
		output = output.replace(/<system_reminder[^>]*>[\s\S]*?<\/system_reminder>/g, "");

		// Hide completed todo lines in the inline overlay.
		output = output
			.split("\n")
			.filter((line) => !line.trim().startsWith("[completed]"))
			.join("\n");

		return output.trim();
	}

	private getDisplayItems(): TodoOverlayItem[] {
		const details = this.result?.details;
		if (details && typeof details === "object") {
			const todos = (details as { todos?: unknown }).todos;
			if (Array.isArray(todos)) {
				return todos
					.filter((todo): todo is { content: string; status: string; priority?: "high" | "medium" | "low" } => {
						return (
							!!todo &&
							typeof todo === "object" &&
							typeof todo.content === "string" &&
							typeof todo.status === "string"
						);
					})
					.filter(
						(todo) => todo.status === "pending" || todo.status === "in_progress" || todo.status === "blocked",
					)
					.map((todo) => ({
						content: todo.content,
						status: todo.status as "pending" | "in_progress" | "blocked",
						priority: todo.priority,
					}));
			}
		}

		return this.getTextOutput()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.flatMap<TodoOverlayItem>((line) => {
				const inProgressMatch = line.match(/^\[in_progress\]\s+(.*)$/);
				if (inProgressMatch) return [{ content: inProgressMatch[1]!, status: "in_progress" }];
				const pendingMatch = line.match(/^\[pending\]\s+(.*)$/);
				if (pendingMatch) return [{ content: pendingMatch[1]!, status: "pending" }];
				const blockedMatch = line.match(/^\[blocked\]\s+(.*)$/);
				if (blockedMatch) return [{ content: blockedMatch[1]!, status: "blocked" }];
				return [];
			});
	}

	private getDisplayLines(): TodoOverlayLine[] {
		const items = this.getDisplayItems();
		if (items.length > 0) {
			return items.map((item) => ({
				kind: "todo",
				text: item.content,
				status: item.status,
				priority: item.priority,
			}));
		}

		return this.getTextOutput()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => ({ kind: "text" as const, text: line }));
	}

	private formatTodoLine(item: TodoOverlayLine): string {
		const status = item.status ?? "pending";
		const statusGlyph =
			status === "in_progress"
				? theme.fg("accent", "▶")
				: status === "blocked"
					? theme.fg("warning", "◆")
					: theme.fg("muted", "○");
		const priorityLabel =
			item.priority === "high"
				? theme.fg("warning", "[H]")
				: item.priority === "low"
					? theme.fg("muted", "[L]")
					: theme.fg("accent", "[M]");
		const contentColor = status === "in_progress" ? "accent" : status === "blocked" ? "warning" : "toolOutput";
		return `${statusGlyph} ${priorityLabel} ${theme.fg(contentColor, item.text)}`;
	}

	private shouldAutoDismiss(details: unknown): boolean {
		if (!details || typeof details !== "object") return false;
		const summary = (details as { summary?: unknown }).summary;
		if (!summary || typeof summary !== "object") return false;

		const pending =
			typeof (summary as { pending?: unknown }).pending === "number" ? (summary as { pending: number }).pending : 0;
		const inProgress =
			typeof (summary as { inProgress?: unknown }).inProgress === "number"
				? (summary as { inProgress: number }).inProgress
				: 0;
		const blocked =
			typeof (summary as { blocked?: unknown }).blocked === "number" ? (summary as { blocked: number }).blocked : 0;
		const total =
			typeof (summary as { total?: unknown }).total === "number" ? (summary as { total: number }).total : 0;
		const completed =
			typeof (summary as { completed?: unknown }).completed === "number"
				? (summary as { completed: number }).completed
				: 0;

		return total > 0 && completed > 0 && pending === 0 && inProgress === 0 && blocked === 0;
	}

	override render(width: number): string[] {
		if (this.dismissed || this.hidden) return [];

		const muDisplay = readMuDisplayV1(this.result?.details) ?? null;
		const lines = this.getDisplayLines();
		if (lines.length === 0) return [];

		const panelWidth = Math.max(20, width);
		const innerWidth = Math.max(1, panelWidth - 4);
		const border = (text: string) => theme.fg("borderMuted", text);
		const bg = (text: string) => theme.bg("toolPendingBg", text);
		const title = theme.bold(theme.fg("accent", "Todo List"));
		const titleFill = Math.max(0, panelWidth - 4 - visibleWidth(title));
		const topLine = bg(`${border("╭─")} ${title}${border("─".repeat(titleFill))}${border("╮")}`);

		const summaryText = muDisplay?.summary?.text ? theme.fg("muted", muDisplay.summary.text) : "";
		const maxLines = this.expanded
			? lines.length
			: (muDisplay?.output?.collapse?.maxVisualLines ?? DEFAULT_MAX_LINES);
		const visibleLines = lines.slice(0, maxLines);
		const hiddenCount = Math.max(0, lines.length - visibleLines.length);
		const hint = hiddenCount > 0 ? `+${hiddenCount} more · ctrl+t to hide` : "ctrl+t to hide";

		const bodyLines = [
			summaryText,
			...visibleLines.map((line) =>
				line.kind === "todo" ? this.formatTodoLine(line) : theme.fg("toolOutput", line.text),
			),
			theme.fg("muted", hint),
		]
			.filter((line) => visibleWidth(line) > 0)
			.map((line) => bg(`${border("│")} ${padStyled(line, innerWidth)} ${border("│")}`));

		const bottomLine = bg(`${border("╰")}${border("─".repeat(panelWidth - 2))}${border("╯")}`);
		return [topLine, ...bodyLines, bottomLine];
	}
}
