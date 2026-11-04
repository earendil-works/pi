// Copied from coding-agent interactive/components/{status-indicator,countdown-timer,custom-editor}.ts with the instance
// theme and key hints (section 5.4). The editor keeps pi's embedded working status in its top border and its
// empty-editor Ctrl+D rule; the paste-image hook and extension shortcuts are gone (launcher-owned, section 3).
import {
	Editor,
	type EditorOptions,
	getKeybindings,
	type Keybinding,
	Loader,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { RenderContext } from "../render-context.ts";

export class StatusIndicator extends Loader {
	readonly kind: "working" | "retry" | "compaction";
	constructor(
		kind: StatusIndicator["kind"],
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
	) {
		super(ui, spinnerColorFn, messageColorFn, message);
		this.kind = kind;
	}
	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}
	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}
	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, ctx: RenderContext, message: string, colorFn?: (text: string) => string) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => ctx.theme.current.fg("accent", text)),
			colorFn ?? ((text) => ctx.theme.current.fg("muted", text)),
			message,
		);
	}
}

/** Counts down to a server-scheduled retry (`live.generation.retry.at`); Esc stops the run. */
export class RetryStatusIndicator extends StatusIndicator {
	private timer: ReturnType<typeof setInterval> | undefined;
	constructor(ui: TUI, ctx: RenderContext, attempt: number, at: number, error: string) {
		const message = () => {
			const seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
			return `Retrying (attempt ${attempt + 1}) in ${seconds}s: ${error} (${ctx.keyText("app.interrupt")} to cancel)`;
		};
		super(
			"retry",
			ui,
			(spinner) => ctx.theme.current.fg("warning", spinner),
			(text) => ctx.theme.current.fg("muted", text),
			message(),
		);
		this.timer = setInterval(() => {
			this.setMessage(message());
			if (Date.now() >= at) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		}, 1000);
	}
	override dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		super.dispose();
	}
}

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, ctx: RenderContext, trigger: "manual" | "threshold" | "overflow", retry?: number) {
		// pi: Escape cancels a compaction (Chat.abortCompaction).
		const cancel = ctx.keyText("app.interrupt") ? ` (${ctx.keyText("app.interrupt")} to cancel)` : "";
		const label =
			retry !== undefined
				? `Retrying ${trigger} compaction (attempt ${retry + 1})...${cancel}`
				: trigger === "manual"
					? `Compacting context...${cancel}`
					: `${trigger === "overflow" ? "Context overflow detected, " : ""}Auto-compacting...${cancel}`;
		super(
			"compaction",
			ui,
			(spinner) => ctx.theme.current.fg("accent", spinner),
			(text) => ctx.theme.current.fg("muted", text),
			label,
		);
	}
}

/** pi's CustomEditor: app actions by binding id, Escape and the empty-editor exit rule, embedded working status. */
export class CustomEditor extends Editor {
	private workingStatusIndicator: StatusIndicator | undefined;
	readonly actionHandlers = new Map<string, () => void>();
	onEscape?: () => void;
	onCtrlD?: () => void;

	constructor(tui: TUI, ctx: RenderContext, options?: EditorOptions) {
		super(tui, ctx.theme.editor, options);
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.workingStatusIndicator || width <= 0) return super.renderTopBorder(width, hiddenLineCount);
		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);
		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;
		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}
		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}
		if (width >= statusWidth + 5)
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	onAction(action: string, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	/** The current keymap (the runtime installs rebuilt managers with setKeybindings). */
	private matches(data: string, id: string): boolean {
		return getKeybindings().matches(data, id as Keybinding);
	}

	override handleInput(data: string): void {
		// Escape/interrupt, only when autocomplete is not active.
		if (this.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			super.handleInput(data);
			return;
		}
		// Exit (Ctrl+D) only when the editor is empty; otherwise it is delete-char-forward.
		if (this.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
		}
		// Explicit history bindings take precedence over app actions while the editor is focused.
		if (this.matches(data, "tui.editor.historyPrevious") || this.matches(data, "tui.editor.historyNext")) {
			super.handleInput(data);
			return;
		}
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.matches(data, action)) {
				handler();
				return;
			}
		}
		super.handleInput(data);
	}
}
