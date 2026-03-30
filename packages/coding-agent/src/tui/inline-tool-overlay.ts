import { Container, Spacer, Text } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import { type MuDisplayV1, readMuDisplayV1 } from "../display/mu-display.js";
import { theme } from "../theme/theme.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Maximum lines to show when collapsed
const DEFAULT_MAX_LINES = 3;

/**
 * Component that renders a tool call in a compact inline format
 * for display above the composer (not in scrollable chat history).
 */
export class InlineToolOverlayComponent extends Container {
	private toolName: string;
	private args: unknown;
	private expanded = false;
	private dismissed = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: unknown;
	};

	constructor(toolName: string, args: unknown) {
		super();
		this.toolName = toolName;
		this.args = args;
	}

	updateResult(result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: unknown;
	}): void {
		this.result = result;
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

	private rebuild(): void {
		this.clear();
		if (this.dismissed) return;

		const muDisplay = readMuDisplayV1(this.result?.details) ?? null;

		// Add tool call line
		const callText = this.formatCallLine(muDisplay);
		this.addChild(new Text(callText, 0, 0));

		// Add summary line if available (inline, same line as tool name if possible)
		// Actually keep separate for readability
		if (muDisplay?.summary?.text) {
			this.addChild(new Text(theme.fg("muted", muDisplay.summary.text), 0, 0));
		}

		// Add output preview if available
		const output = this.getTextOutput();
		if (output) {
			const maxLines = this.expanded ? Infinity : (muDisplay?.output?.collapse?.maxVisualLines ?? DEFAULT_MAX_LINES);

			if (maxLines < Infinity && !this.expanded) {
				// Collapsed view with truncation
				const styledOutput = output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				const result = truncateToVisualLines(
					styledOutput,
					maxLines,
					76, // approximate width accounting for padding
					0,
				);

				// Show lines first, then hint
				for (const line of result.visualLines.slice(0, maxLines)) {
					this.addChild(new Text(line, 0, 0));
				}

				if (result.skippedCount > 0) {
					const hint = muDisplay?.output?.collapse?.expandHint ?? "ctrl+o to expand";
					this.addChild(new Text(theme.fg("muted", `... (${result.skippedCount} more lines · ${hint})`), 0, 0));
				}
			} else {
				// Expanded view - limit to reasonable height even when expanded
				const lines = output.split("\n").slice(0, 15);
				for (const line of lines) {
					this.addChild(new Text(theme.fg("toolOutput", line), 0, 0));
				}
			}
		}
	}

	private formatCallLine(muDisplay: MuDisplayV1 | null): string {
		const toolNameStyled = theme.fg("toolTitle", theme.bold(this.toolName));

		if (muDisplay?.call?.text) {
			return `${toolNameStyled} ${theme.fg("accent", muDisplay.call.text)}`;
		}

		if (muDisplay?.call?.argv && muDisplay.call.argv.length > 0) {
			const argvText = muDisplay.call.argv.join(" ");
			return `${toolNameStyled} ${theme.fg("accent", argvText)}`;
		}

		return toolNameStyled;
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c) => c.type === "text") || [];
		let output = textBlocks.map((c) => stripAnsi(c.text || "").replace(/\r/g, "")).join("\n");

		// Strip system_reminder tags
		output = output.replace(/<system_reminder[^>]*>[\s\S]*?<\/system_reminder>/g, "");

		return output.trim();
	}

	override render(width: number): string[] {
		if (this.dismissed) return [];
		return super.render(width);
	}
}
