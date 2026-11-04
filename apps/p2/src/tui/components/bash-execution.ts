// Copied from coding-agent interactive/components/bash-execution.ts (p2-tui-port.md section 10.8, `!cmd`/`!!cmd`).
// Changes: the instance theme and key hints (section 5.4) instead of globals; the output is server text, sanitized
// (`safeText`) instead of `stripAnsi`; pi's `truncateTail` is `shellTail` (src/runtime/shell.ts, the same limits); the
// loader exists only for a live command (an entry renderer has no TUI); the author is named for others' commands.
import { Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { shellData, shellTail } from "../../runtime/shell.ts";
import type { TuiEntryRenderer } from "../../runtime/tui-renderers.ts";
import { keyHint, lineText, type RenderContext, safeText } from "../render-context.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private error: string | undefined;
	private loader: Loader | undefined;
	private truncated = false;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	/** `dim` marks `!!` commands, whose output is excluded from the model context. */
	private readonly colorKey: "dim" | "bashMode";
	private outputPad: number;
	private readonly ctx: RenderContext;
	/** Shown after the command for someone else's command ("Alice (guest)"). */
	private readonly by: string | undefined;

	constructor(
		command: string,
		ctx: RenderContext,
		options: { excludeFromContext?: boolean; outputPad?: number; tui?: TUI; by?: string } = {},
	) {
		super();
		this.ctx = ctx;
		this.command = command;
		this.by = options.by;
		this.colorKey = options.excludeFromContext ? "dim" : "bashMode";
		this.outputPad = options.outputPad ?? 1;
		const border = {
			render: (width: number) => [this.ctx.theme.current.fg(this.colorKey, "─".repeat(Math.max(1, width)))],
			invalidate: () => {},
		};

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(border);

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (options.tui)
			this.loader = new Loader(
				options.tui,
				(spinner) => this.ctx.theme.current.fg(this.colorKey, spinner),
				(text) => this.ctx.theme.current.fg("muted", text),
				`Running... (${this.ctx.keyText("app.interrupt")} to cancel)`, // Plain text for loader
			);

		// Bottom border
		this.addChild(border);

		this.updateDisplay();
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/** Replaces the output (p2 publishes the retained tail as state, not chunks). */
	setOutput(output: string, truncated: boolean): void {
		// Server text: terminal controls are stripped; line endings normalized.
		const clean = safeText(output.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
		this.outputLines = clean ? clean.split("\n") : [];
		this.truncated = truncated;
		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options: { truncated?: boolean; fullOutputPath?: string; error?: string } = {},
	): void {
		this.exitCode = exitCode;
		this.error = options.error;
		this.status = cancelled
			? "cancelled"
			: options.error !== undefined || (exitCode !== 0 && exitCode !== undefined)
				? "error"
				: "complete";
		this.truncated ||= options.truncated ?? false;
		this.fullOutputPath = options.fullOutputPath;

		// Stop loader
		this.loader?.stop();

		this.updateDisplay();
	}

	/** Stops the loader's timer (a live command's component that is dropped while running). */
	dispose(): void {
		this.loader?.stop();
	}

	private updateDisplay(): void {
		const theme = this.ctx.theme.current;
		// Apply truncation for LLM context limits (same limits as bash tool)
		const contextTruncation = shellTail(this.outputLines.join("\n"));

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.text ? contextTruncation.text.split("\n") : [];

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command header
		const by = this.by ? theme.fg("muted", ` · ${lineText(this.by)}`) : "";
		const header = new Text(
			theme.fg(this.colorKey, theme.bold(`$ ${lineText(this.command)}`)) + by,
			this.outputPad,
			0,
		);
		this.contentContainer.addChild(header);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, this.outputPad, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, this.outputPad);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			if (this.loader) this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint(this.ctx, "app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint(this.ctx, "app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(
					theme.fg("error", this.error !== undefined ? `(${lineText(this.error)})` : `(exit ${this.exitCode})`),
				);
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${lineText(this.fullOutputPath)}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, this.outputPad, 0));
			}
		}
	}
}

/** Who ran someone else's command: guests by name; the owner's commands carry no label. */
export const shellAuthor = (author: { kind: "owner" | "guest"; name: string }): string | undefined =>
	author.kind === "guest" ? `${author.name} (guest)` : undefined;

/**
 * A finished `p2.shell` entry (src/runtime/shell.ts): this component, completed. The core facet registers it, as the
 * entry kind is the host's, not a plugin's.
 */
export const shellEntryRenderer: TuiEntryRenderer = (entry, ctx) => {
	const data = shellData(entry.data);
	if (!data) return undefined;
	const component = new BashExecutionComponent(data.command, ctx, {
		excludeFromContext: !data.includeInContext,
		by: shellAuthor(data.author),
	});
	component.setExpanded(ctx.expanded);
	component.setOutput(data.output, data.truncated);
	component.setComplete(data.exitCode, data.cancelled, {
		truncated: data.truncated,
		...(data.fullOutputPath === undefined ? {} : { fullOutputPath: data.fullOutputPath }),
		...(data.error === undefined ? {} : { error: data.error }),
	});
	return component;
};
