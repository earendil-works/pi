import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { Container, getKeybindings, isViewportTUI, ScrollView, setKeybindings, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { FullscreenExitOutput, TuiMode } from "../src/core/settings-manager.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		expect(mainTui.mode).toBe("regular");
		expect(isViewportTUI(mainTui)).toBe(false);
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		expect(altTui.mode).toBe("fullscreen");
		expect(isViewportTUI(altTui)).toBe(true);
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		altTui.stop();
	});

	it("shows the configured jump-to-bottom shortcut while scrolled up", async () => {
		initTheme("dark");
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+j" }));
		const terminal = new RecordingTerminal(50, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		ui.setLayoutRoot(
			new ScrollView(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0), {
				follow: "end",
				primary: true,
			}),
		);
		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			expect(terminal.getViewport()[3]).toContain("↓ Jump to latest message · Ctrl+J");
		} finally {
			ui.stop();
			setKeybindings(previousKeybindings);
		}
	});

	it("replaces the renderer and restores the previous screen for resume-hint exits", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		let stableUi: TUI;
		const invalidatedModes: TuiMode[] = [];
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => invalidatedModes.push(stableUi.mode),
		};
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			runtimeHost: { session: { settingsManager: { getFullscreenCopyOnSelect: () => boolean } } };
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: { settingsManager: { getFullscreenCopyOnSelect: () => true } } },
			renderer,
			ui: undefined as unknown as TUI,
			fullscreenLayoutRoot: component,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { stopInteractiveTui, switchTuiMode } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: SwitchContext, fullscreenExitOutput: FullscreenExitOutput): void;
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		await terminal.waitForRender();
		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		expect(stableUi.mode).toBe("fullscreen");
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);

		stopInteractiveTui.call(context, "resume-hint");

		expect(stableUi.mode).toBe("fullscreen");
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 2]);
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean; preferSelection?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("copies an active fullscreen selection when copy-on-select is disabled", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			fullscreenCopyOnSelect: false,
		});
		const getLastAssistantText = vi.fn(() => "assistant response");
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText },
			ui,
			showStatus,
			showError,
		};
		ui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));

		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			clipboardMocks.copyToClipboard.mockClear();

			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledOnce();
			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("alpha\nbeta");
			expect(getLastAssistantText).not.toHaveBeenCalled();
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("copies the last assistant message with an active fullscreen selection when copy-on-select is enabled", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const getLastAssistantText = vi.fn(() => "assistant response");
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText },
			ui,
			showStatus,
			showError,
		};
		ui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));

		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			clipboardMocks.copyToClipboard.mockClear();

			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledOnce();
			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(getLastAssistantText).toHaveBeenCalledOnce();
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("flashes Copied! for the copy shortcut in fullscreen mode", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		ui.start();
		try {
			await terminal.waitForRender();
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("keeps the status-line confirmation for the copy shortcut in regular mode", async () => {
		const ui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });

		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});
});

type StatusEditor = {
	embedWorkingStatus: boolean;
	setWorkingStatusIndicator: (indicator: undefined) => void;
};

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working" | "retry"; dispose: () => void } | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	statusContainer: Container;
	defaultEditor: StatusEditor;
	editor: Partial<StatusEditor>;
	options: { tuiMode?: TuiMode };
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
	setEditorWorkingStatusIndicator(indicator: undefined): boolean;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working" | "retry"): void;
	setEditorWorkingStatusIndicator(this: ClearStatusContext, indicator: undefined): boolean;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("does not reserve separate status height for the editor-border working indicator", () => {
		const dispose = vi.fn();
		const editor: StatusEditor = { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() };
		const context: ClearStatusContext = {
			activeStatusIndicator: { kind: "working", dispose },
			activeWorkingIndicatorEmbedded: true,
			statusContainer: new Container(),
			defaultEditor: editor,
			editor,
			options: { tuiMode: "regular" },
			ui: { getClearOnShrink: () => true },
			idleStatus: new Text("", 0, 0),
			setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
		};

		interactiveModePrototype.clearStatusIndicator.call(context);

		expect(dispose).toHaveBeenCalledOnce();
		expect(editor.setWorkingStatusIndicator).toHaveBeenCalledWith(undefined);
		expect(context.statusContainer.children).toHaveLength(0);
	});

	it("uses the standalone row for a custom editor that has not opted in", () => {
		for (const [tuiMode, expectedChildren] of [
			["regular", 1],
			["fullscreen", 0],
		] as const) {
			const defaultEditor: StatusEditor = { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() };
			const customEditor = { embedWorkingStatus: false, setWorkingStatusIndicator: vi.fn() };
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose: vi.fn() },
				activeWorkingIndicatorEmbedded: false,
				statusContainer: new Container(),
				defaultEditor,
				editor: customEditor,
				options: { tuiMode },
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
				setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(defaultEditor.setWorkingStatusIndicator).toHaveBeenCalledWith(undefined);
			expect(customEditor.setWorkingStatusIndicator).not.toHaveBeenCalled();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
