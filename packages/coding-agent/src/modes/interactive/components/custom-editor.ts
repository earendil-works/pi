import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import {
	Editor,
	type EditorContent,
	type EditorOptions,
	type EditorTheme,
	type OverlayHandle,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { normalizePath } from "../../../utils/paths.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { PromptContentPreview } from "./prompt-content-preview.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
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
		this.onAction("app.editor.preview", () => this.previewContent());
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

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

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		const key = keyDisplayText("app.editor.preview");
		const hint = ` ${key} preview `;
		if (!key || hiddenLineCount > 0 || width < visibleWidth(hint) + 4 || !this.getContentAtCursor()) {
			return super.renderBottomBorder(width, hiddenLineCount);
		}
		return this.borderColor(`──${hint}${"─".repeat(width - visibleWidth(hint) - 2)}`);
	}

	protected override shouldCollapsePaste(text: string, lineCount: number): boolean {
		if (/^(?:https?:\/\/\S+|@\S+)$/i.test(text.trim())) return false;
		return lineCount >= 4 || text.length > 300;
	}

	protected override handlePaste(text: string): void {
		if (!this.getExpandedText().trimStart().startsWith("!")) {
			const parts = attachmentParts(text);
			if (parts) {
				const cursor = this.getCursor();
				const before = this.getLines()[cursor.line]!.slice(0, cursor.col);
				if (/^[/~.]/.test(text) && /\w$/.test(before)) parts.unshift(" ");
				this.insertContent(parts);
				return;
			}
		}
		super.handlePaste(text);
	}

	override insertTextAtCursor(text: string): void {
		if (!text) return;
		// Clipboard files in shell mode are already quoted by the caller.
		if (this.getExpandedText().trimStart().startsWith("!")) {
			super.insertTextAtCursor(text);
			return;
		}
		this.handlePaste(text);
	}

	private previewContent(): void {
		const items = this.getContentItems();
		if (items.length === 0) return;
		let handle: OverlayHandle;
		const preview = new PromptContentPreview(
			this.tui,
			this.keybindings,
			this,
			items,
			this.getContentAtCursor(),
			() => {
				preview.dispose();
				handle.hide();
				this.tui.requestRender();
			},
		);
		handle = this.tui.showOverlay(preview, { width: "90%", maxHeight: "80%", anchor: "center" });
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

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
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

interface PathToken {
	start: number;
	end: number;
	value: string;
}

/** Recognize only complete lists of existing files; prose, URLs, and @references stay text. */
function attachmentParts(text: string): (string | EditorContent)[] | undefined {
	const parts: (string | EditorContent)[] = [];
	let end = 0;
	for (const match of text.matchAll(/[^\r\n]+/g)) {
		const line = match[0];
		if (!line.trim()) continue;
		const trimmed = line.trim();
		const whole = attachmentFromPath(line, line) ?? attachmentFromPath(trimmed, trimmed);
		if (whole) {
			const start = match.index + (whole.text === line ? 0 : line.indexOf(trimmed));
			parts.push(text.slice(end, start), whole);
			end = start + whole.text.length;
			continue;
		}
		const tokens = pathTokens(line);
		if (!tokens?.length) return undefined;
		for (const token of tokens) {
			const raw = line.slice(token.start, token.end);
			const attachment = attachmentFromPath(token.value, raw);
			if (!attachment) return undefined;
			parts.push(text.slice(end, match.index + token.start), attachment);
			end = match.index + token.end;
		}
	}
	if (parts.length === 0) return undefined;
	parts.push(text.slice(end));
	return parts;
}

function attachmentFromPath(value: string, text: string): EditorContent | undefined {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}
	if (!/^(?:[/~]|[a-z]:[\\/]|\\\\|file:\/\/)/i.test(value) || /\p{Cc}/u.test(value)) return undefined;
	try {
		const path = normalizePath(value);
		if (!statSync(path).isFile()) return undefined;
		const name = basename(path);
		const label = /^pi-clipboard-[a-f\d-]+\./i.test(name)
			? "clipboard"
			: truncateToWidth(stripTerminalSequences(name).replace(/[\p{Cc}[\]]/gu, " "), 24);
		return {
			kind: /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(extname(path)) ? "image" : "file",
			text,
			path,
			label,
		};
	} catch {
		return undefined;
	}
}

/** Decode quoted/escaped OS drag-and-drop paths without executing shell syntax or expanding variables. */
function pathTokens(line: string): PathToken[] | undefined {
	const tokens: PathToken[] = [];
	let index = 0;
	while (index < line.length) {
		while (/\s/.test(line[index] ?? "") && index < line.length) index++;
		if (index === line.length) break;
		const start = index;
		let value = "";
		let quote: "'" | '"' | undefined;
		while (index < line.length) {
			const char = line[index]!;
			if (!quote && /\s/.test(char)) break;
			if (char === quote) {
				quote = undefined;
			} else if (!quote && (char === "'" || char === '"')) {
				quote = char;
			} else if (char === "\\" && quote !== "'" && process.platform !== "win32") {
				const next = line[index + 1];
				if (next === undefined) return undefined;
				if (quote === '"' && !/[\\$"`]/.test(next)) value += char;
				else {
					value += next;
					index++;
				}
			} else {
				value += char;
			}
			index++;
		}
		if (quote) return undefined;
		tokens.push({ start, end: index, value });
	}
	return tokens;
}
