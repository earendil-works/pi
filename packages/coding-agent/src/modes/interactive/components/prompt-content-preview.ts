// Preview compact prompt items without adding messages or model calls to the session.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	Container,
	Editor,
	type EditorContent,
	type EditorContentItem,
	type Focusable,
	Image,
	SelectList,
	stripTerminalSequences,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { createReadTool } from "../../../core/tools/read.ts";
import { readClipboardText } from "../../../utils/clipboard.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

type PasteContent = Extract<EditorContent, { kind: "paste" }>;
type FileStatus =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| {
			kind: "ready";
			content: (TextContent | ImageContent)[];
			view?: Container;
			height: number;
			offset: number;
			lineCount: number;
	  };

type PreviewState =
	| { kind: "choose"; list: SelectList }
	| { kind: "paste"; title: string; content: PasteContent; editor: Editor; error?: string }
	| { kind: "file"; title: string; path: string; controller: AbortController; status: FileStatus };

/** Inspect attachments and edit text pastes while keeping the main prompt intact until apply. */
export class PromptContentPreview implements Focusable {
	readonly capturesViewportInput = true;
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly owner: Editor;
	private readonly close: () => void;
	private state: PreviewState;
	private closed = false;
	private _focused = false;

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		owner: Editor,
		items: EditorContentItem[],
		selected: EditorContentItem | undefined,
		close: () => void,
	) {
		this.tui = tui;
		this.keybindings = keybindings;
		this.owner = owner;
		this.close = close;
		const item = selected ?? (items.length === 1 ? items[0] : undefined);
		if (item) {
			this.state = this.itemState(item);
		} else {
			const list = new SelectList(
				items.map((item, index) => ({ value: String(index), label: item.marker })),
				Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 4),
				getEditorTheme().selectList,
			);
			list.onSelect = (selection) => {
				this.state = this.itemState(items[Number(selection.value)]!);
			};
			this.state = { kind: "choose", list };
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.state.kind === "paste") this.state.editor.focused = value;
	}

	dispose(): void {
		this.closed = true;
		if (this.state.kind === "file") this.state.controller.abort();
	}

	invalidate(): void {
		if (this.state.kind === "paste") this.state.editor.invalidate();
		if (this.state.kind === "file" && this.state.status.kind === "ready") this.state.status.view?.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		const state = this.state;
		if (state.kind === "choose") {
			state.list.handleInput(data);
		} else if (state.kind === "paste") {
			if (this.keybindings.matches(data, "tui.input.newLine")) {
				state.editor.handleInput(data);
			} else if (this.keybindings.matches(data, "tui.select.confirm")) {
				// Editor.onSubmit trims and resets the draft; an in-place edit must preserve whitespace.
				if (this.owner.updatePaste(state.content, state.editor.getExpandedText())) this.close();
				else state.error = "This block changed. Close the preview and reopen it.";
			} else if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
				void this.pasteText(state);
			} else {
				state.editor.handleInput(data);
			}
		} else if (state.status.kind === "ready") {
			const page = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8) - 4);
			const delta = this.keybindings.matches(data, "tui.select.up")
				? -1
				: this.keybindings.matches(data, "tui.select.down")
					? 1
					: this.keybindings.matches(data, "tui.select.pageUp")
						? -page
						: this.keybindings.matches(data, "tui.select.pageDown")
							? page
							: 0;
			state.status.offset = Math.max(
				0,
				Math.min(Math.max(0, state.status.lineCount - page), state.status.offset + delta),
			);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const state = this.state;
		if (state.kind === "paste" && this.tui.terminal.rows < 8) return state.editor.render(width);
		const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8) - 4);
		let title: string;
		let body: string[];
		let hint: string;
		if (state.kind === "choose") {
			title = "Prompt content";
			body = state.list.render(width);
			hint = `${keyHint("tui.select.confirm", "open")}  ${keyHint("tui.select.cancel", "close")}`;
		} else if (state.kind === "paste") {
			title = state.title;
			body = state.editor.render(width);
			hint = state.error
				? theme.fg("error", previewText(state.error))
				: `${keyHint("tui.select.confirm", "apply")}  ${keyHint("tui.input.newLine", "newline")}  ${keyHint("tui.select.cancel", "cancel")}`;
		} else {
			title = state.title;
			if (state.status.kind === "loading") body = [theme.fg("muted", "Reading preview…")];
			else if (state.status.kind === "error")
				body = new Text(theme.fg("error", previewText(state.status.message)), 0, 0).render(width);
			else {
				const status = state.status;
				if (!status.view || status.height !== height) {
					const view = new Container();
					view.addChild(new Text(theme.fg("muted", previewText(state.path)), 0, 0));
					for (const block of status.content) {
						view.addChild(
							block.type === "text"
								? new Text(previewText(block.text), 0, 0)
								: new Image(
										block.data,
										block.mimeType,
										{ fallbackColor: (text) => theme.fg("muted", text) },
										{ maxHeightCells: Math.max(1, height - 4) },
									),
						);
					}
					status.view = view;
					status.height = height;
				}
				const lines = status.view.render(width);
				status.lineCount = lines.length;
				status.offset = Math.min(status.offset, Math.max(0, lines.length - height));
				body = lines.slice(status.offset, status.offset + height);
			}
			hint = `${rawKeyHint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "scroll")}  ${rawKeyHint(`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`, "page")}  ${keyHint("tui.select.cancel", "close")}`;
		}
		const border = theme.fg("border", "─".repeat(width));
		return [
			border,
			theme.fg("accent", truncateToWidth(title, width)),
			...body.slice(0, height),
			truncateToWidth(hint, width),
			border,
		];
	}

	private itemState(item: EditorContentItem): PreviewState {
		if (item.content.kind === "paste") {
			const editor = new PromptContentEditor(this.tui, getEditorTheme());
			editor.disableSubmit = true;
			editor.setText(item.content.text);
			editor.focused = this._focused;
			return { kind: "paste", title: item.marker, content: item.content, editor };
		}
		const state: Extract<PreviewState, { kind: "file" }> = {
			kind: "file",
			title: item.marker,
			path: item.content.path,
			controller: new AbortController(),
			status: { kind: "loading" },
		};
		void this.readFile(state);
		return state;
	}

	private async readFile(state: Extract<PreviewState, { kind: "file" }>): Promise<void> {
		try {
			const result = await createReadTool(process.cwd()).execute(
				"prompt-preview",
				{ path: state.path },
				state.controller.signal,
			);
			if (this.closed || this.state !== state) return;
			state.status = { kind: "ready", content: result.content, height: 0, offset: 0, lineCount: 0 };
		} catch (error) {
			if (this.closed || this.state !== state) return;
			state.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
		}
		this.tui.requestRender();
	}

	private async pasteText(state: Extract<PreviewState, { kind: "paste" }>): Promise<void> {
		try {
			const text = await readClipboardText();
			if (text && !this.closed && this.state === state) state.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
		} catch (error) {
			if (!this.closed && this.state === state) state.error = error instanceof Error ? error.message : String(error);
		}
		this.tui.requestRender();
	}
}

/** Editing a block shows its full contents instead of creating another hidden block inside the preview. */
class PromptContentEditor extends Editor {
	protected override shouldCollapsePaste(): boolean {
		return false;
	}

	protected override getMaxVisibleLines(terminalRows: number): number {
		return Math.max(1, Math.floor(terminalRows * 0.8) - 6);
	}
}

function previewText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");
}
