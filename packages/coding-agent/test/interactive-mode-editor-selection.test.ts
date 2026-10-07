import { Container, getKeybindings, setKeybindings, Text, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { TuiMode } from "../src/core/settings-manager.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn(async (_text: string) => {}),
	readClipboardFilePaths: vi.fn(async () => null),
	readClipboardText: vi.fn(async () => null),
}));
vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

const prototype = InteractiveMode.prototype as unknown as {
	setupKeyHandlers(this: unknown): void;
	handleCopyCommand(
		this: unknown,
		options?: { flashConfirmation?: boolean; preferSelection?: boolean },
	): Promise<void>;
	setCustomEditorComponent(this: unknown, factory: undefined | (() => CustomEditor)): void;
};
const previousKeybindings = getKeybindings();
const renderers: TUI[] = [];

beforeEach(() => {
	initTheme("dark");
	clipboardMocks.copyToClipboard.mockClear();
});

afterEach(() => {
	for (const renderer of renderers) renderer.stop();
	renderers.length = 0;
	setKeybindings(previousKeybindings);
});

async function createEditor(tuiMode: TuiMode = "fullscreen", fullscreenCopyOnSelect = false) {
	const terminal = new VirtualTerminal(50, 12);
	const ui = createInteractiveTui({
		tuiMode,
		fullscreenCopyOnSelect,
		terminal,
		showHardwareCursor: false,
		logDirectory: tmpdir(),
	});
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, defaultEditorTheme, keybindings);
	editor.setText("draft");
	const context = {
		renderer: ui,
		ui,
		defaultEditor: editor,
		editor,
		editorContainer: new Container(),
		keybindings,
		disposeActiveSelector: vi.fn(),
		isBashMode: false,
		updateEditorBorderColor: vi.fn(),
		handleCopyCommand: prototype.handleCopyCommand,
		session: { getLastAssistantText: () => "assistant response" },
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	prototype.setupKeyHandlers.call(context);
	ui.addChild(new Text("alpha\nbeta", 0, 0));
	context.editorContainer.addChild(editor);
	ui.addChild(context.editorContainer);
	ui.setFocus(editor);
	renderers.push(ui);
	ui.start();
	await terminal.waitForRender();
	return {
		terminal,
		ui,
		editor,
		keybindings,
		context,
		hasActiveSelection: () => ui instanceof TuiAltScreen && ui.hasActiveSelection(),
	};
}

async function selectText(terminal: VirtualTerminal): Promise<void> {
	terminal.sendInput("\x1b[<0;1;1M");
	terminal.sendInput("\x1b[<32;4;2M");
	terminal.sendInput("\x1b[<0;4;2m");
	await terminal.waitForRender();
}

// Regression: https://github.com/earendil-works/pi/issues/10592
describe("editor changes and fullscreen selection", () => {
	it.each([true, false])("clears selection when typing with copy-on-select=%s", async (copyOnSelect) => {
		const { terminal, hasActiveSelection, editor } = await createEditor("fullscreen", copyOnSelect);
		await selectText(terminal);
		expect(hasActiveSelection()).toBe(true);
		terminal.sendInput("x");
		await terminal.waitForRender();
		expect(editor.getText()).toBe("draftx");
		expect(hasActiveSelection()).toBe(false);
	});

	it.each([
		{ input: "\x7f", expected: "draf", action: "deleting" },
		{ input: "\x1b[200~pasted\x1b[201~", expected: "draftpasted", action: "pasting" },
	])("clears selection when $action", async ({ input, expected }) => {
		const { terminal, hasActiveSelection, editor } = await createEditor();
		await selectText(terminal);
		expect(hasActiveSelection()).toBe(true);
		terminal.sendInput(input);
		await terminal.waitForRender();
		expect(editor.getText()).toBe(expected);
		expect(hasActiveSelection()).toBe(false);
	});

	it("keeps selection for cursor movement and the copy shortcut", async () => {
		const { terminal, hasActiveSelection, editor } = await createEditor();
		await selectText(terminal);
		terminal.sendInput("\x1b[D");
		await terminal.waitForRender();
		expect(editor.getCursor().col).toBe(4);
		expect(hasActiveSelection()).toBe(true);
		terminal.sendInput("\x18"); // Ctrl+X: app.message.copy
		await terminal.waitForRender();
		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("alpha\nbeta");
		expect(editor.getText()).toBe("draft");
		expect(hasActiveSelection()).toBe(true);
	});

	it("clears selection after an extension replaces the editor", async () => {
		const { terminal, ui, keybindings, context, hasActiveSelection } = await createEditor();
		const replacement = new CustomEditor(ui, defaultEditorTheme, keybindings);
		prototype.setCustomEditorComponent.call(context, () => replacement);
		await terminal.waitForRender();
		await selectText(terminal);
		expect(hasActiveSelection()).toBe(true);
		terminal.sendInput("x");
		await terminal.waitForRender();
		expect(replacement.getText()).toBe("draftx");
		expect(hasActiveSelection()).toBe(false);
	});

	it.each(["\x0b", "\x1b[3~"])("keeps selection when deletion at the end changes nothing (%j)", async (input) => {
		const { terminal, editor, hasActiveSelection } = await createEditor();
		await selectText(terminal);
		terminal.sendInput(input);
		await terminal.waitForRender();
		expect(editor.getText()).toBe("draft");
		expect(hasActiveSelection()).toBe(true);
	});

	it("keeps selection when a programmatic update repeats the current text", async () => {
		const { terminal, editor, hasActiveSelection } = await createEditor();
		await selectText(terminal);
		editor.setText("draft");
		await terminal.waitForRender();
		expect(hasActiveSelection()).toBe(true);
	});

	it("redraws a cleared selection after a programmatic editor change", async () => {
		const { terminal, ui, editor } = await createEditor();
		if (!(ui instanceof TuiAltScreen)) throw new Error("Expected fullscreen renderer");
		const unselectedLines = ui.getScreenLines().slice(0, 2);
		await selectText(terminal);
		expect(ui.getScreenLines().slice(0, 2)).not.toEqual(unselectedLines);
		editor.setText("changed");
		await terminal.waitForRender();
		expect(ui.getScreenLines().slice(0, 2)).toEqual(unselectedLines);
	});

	it("still updates bash mode in the regular renderer", async () => {
		const { terminal, editor, context } = await createEditor("regular");
		editor.setText("");
		terminal.sendInput("!");
		await terminal.waitForRender();
		expect(editor.getText()).toBe("!");
		expect(context.isBashMode).toBe(true);
		expect(context.updateEditorBorderColor).toHaveBeenCalledOnce();
	});
});
