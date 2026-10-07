import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/** Corners of the editor's border lines that can carry border content. */
export type EditorBorderSlot = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/**
 * Content shown in one border slot. The editor renders one line per slot.
 * `render` is the full form; `renderCompact` is an optional smaller form used
 * when the full one does not fit the slot's width budget. Both may be styled.
 */
export interface EditorBorderContent {
	render(width: number): string;
	renderCompact?(width: number): string;
}

/** Divide `budget` columns across items sized `widths`: equal shares, leftovers go left-first. */
function splitBudget(widths: number[], budget: number): number[] {
	const shares = widths.map(() => 0);
	let remaining = Math.max(0, budget);
	for (let i = 0; i < widths.length; i++) {
		const take = Math.min(widths[i]!, Math.floor(remaining / (widths.length - i)));
		shares[i] = take;
		remaining -= take;
	}
	for (let i = 0; i < widths.length && remaining > 0; i++) {
		const extra = Math.min(widths[i]! - shares[i]!, remaining);
		shares[i] += extra;
		remaining -= extra;
	}
	return shares;
}

/** Render one edge's items into at most `budget` columns, separated by border-styled spaces. */
function renderBorderItems(
	items: EditorBorderContent[],
	budget: number,
	width: number,
	borderColor: (text: string) => string,
): string {
	const full = items.map((item) => item.render(width));
	const shares = splitBudget(
		full.map((line) => visibleWidth(line)),
		Math.max(0, budget - (items.length - 1)),
	);
	const parts: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const share = shares[i]!;
		let line = full[i]!;
		if (visibleWidth(line) > share) {
			line = items[i]!.renderCompact?.(share) ?? line;
		}
		line = truncateToWidth(line, share, "");
		if (visibleWidth(line) > 0) parts.push(line);
	}
	return parts.join(borderColor(" "));
}

/**
 * Compose one border line from slot content: `── left ─── label ─── right ──`
 * with dashes filling the gaps and the scroll label centered. Each side splits
 * the free width evenly (left-first on ties) and degrades per item from the
 * full form to `renderCompact` to truncation. The label is dropped before
 * either side loses all of its width. Returns undefined when nothing is visible.
 */
function composeBorderLine(
	width: number,
	borderColor: (text: string) => string,
	left: EditorBorderContent[],
	right: EditorBorderContent[],
	label: string | undefined,
): string | undefined {
	const naturalLeft = visibleWidth(renderBorderItems(left, width, width, borderColor));
	const naturalRight = visibleWidth(renderBorderItems(right, width, width, borderColor));
	if (naturalLeft === 0 && naturalRight === 0) return undefined;

	const labelWidth = label === undefined ? 0 : visibleWidth(label);
	const bothSides = naturalLeft > 0 && naturalRight > 0;
	let showLabel = label !== undefined && labelWidth + 2 <= width;
	let leftBudget = 0;
	let rightBudget = 0;
	if (showLabel) {
		const labelStart = Math.floor((width - labelWidth) / 2);
		leftBudget = labelStart - 5;
		rightBudget = width - labelStart - labelWidth - 5;
		if ((naturalLeft > 0 && leftBudget < 1) || (naturalRight > 0 && rightBudget < 1)) {
			showLabel = false;
		}
	}
	if (!showLabel) {
		const shares = splitBudget([naturalLeft, naturalRight], width - 5 - (bothSides ? 4 : 0));
		leftBudget = shares[0]!;
		rightBudget = shares[1]!;
	}

	const leftText = renderBorderItems(left, leftBudget, width, borderColor);
	const rightText = renderBorderItems(right, rightBudget, width, borderColor);
	const leftWidth = visibleWidth(leftText);
	const rightWidth = visibleWidth(rightText);
	if (leftWidth === 0 && rightWidth === 0) return undefined;

	const leftBlockWidth = leftWidth > 0 ? 3 + leftWidth + 1 : 0;
	const rightBlockWidth = rightWidth > 0 ? 1 + rightWidth + 1 + 2 : 0;
	const labelStart = Math.floor((width - labelWidth) / 2);
	const gap1 = showLabel ? labelStart - leftBlockWidth : width - leftBlockWidth - rightBlockWidth;
	const gap2 = showLabel ? width - rightBlockWidth - labelStart - labelWidth : 0;
	const middle =
		(leftWidth > 0 ? " " : "") +
		"─".repeat(Math.max(0, gap1)) +
		(showLabel ? label! : "") +
		"─".repeat(Math.max(0, gap2)) +
		(rightWidth > 0 ? " " : "");

	const parts: string[] = [];
	if (leftWidth > 0) parts.push(borderColor("── "), leftText);
	parts.push(borderColor(middle));
	if (rightWidth > 0) parts.push(rightText, borderColor(" ──"));
	const line = parts.join("");
	return visibleWidth(line) === width ? line : undefined;
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private borderContent = new Map<string, { slot: EditorBorderSlot; content: EditorBorderContent }>();
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	/** Show `content` in a border slot under `key`, replacing content set with the same key. Pass undefined to clear. */
	setBorderContent(slot: EditorBorderSlot, key: string, content: EditorBorderContent | undefined): void {
		if (content === undefined) {
			this.borderContent.delete(key);
		} else {
			this.borderContent.set(key, { slot, content });
		}
		this.tui.requestRender();
	}

	/** Clear every border slot. */
	clearBorderContent(): void {
		this.borderContent.clear();
		this.tui.requestRender();
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return (
			this.renderBorderWithContent(width, hiddenLineCount, "↑", "topLeft", "topRight") ??
			super.renderTopBorder(width, hiddenLineCount)
		);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		return (
			this.renderBorderWithContent(width, hiddenLineCount, "↓", "bottomLeft", "bottomRight") ??
			super.renderBottomBorder(width, hiddenLineCount)
		);
	}

	private renderBorderWithContent(
		width: number,
		hiddenLineCount: number,
		direction: "↑" | "↓",
		leftSlot: EditorBorderSlot,
		rightSlot: EditorBorderSlot,
	): string | undefined {
		if (width <= 0) return undefined;
		const left: EditorBorderContent[] = [];
		const right: EditorBorderContent[] = [];
		if (direction === "↑" && this.embedWorkingStatus && this.workingStatusIndicator) {
			const indicator = this.workingStatusIndicator;
			left.push({
				render: (w) => indicator.renderInBorder(w),
				renderCompact: (w) => indicator.renderSpinnerInBorder(w),
			});
		}
		for (const entry of this.borderContent.values()) {
			if (entry.slot === leftSlot) left.push(entry.content);
			else if (entry.slot === rightSlot) right.push(entry.content);
		}
		if (left.length === 0 && right.length === 0) return undefined;
		const label = hiddenLineCount > 0 ? ` ${direction} ${hiddenLineCount} more ` : undefined;
		return composeBorderLine(width, (text) => this.borderColor(text), left, right, label);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
