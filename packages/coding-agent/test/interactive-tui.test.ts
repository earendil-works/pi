import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, ScrollView, stripTerminalSequences, Text, VStack } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { FullscreenExitOutput, TuiMode } from "../src/core/settings-manager.ts";
import { StatusRegionComponent, TranscriptStatusIndicator } from "../src/modes/interactive/components/status-region.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";

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
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
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

describe("fullscreen transcript scroll indicator", () => {
	it("shares the existing status region without changing its idle height", async () => {
		const terminal = new RecordingTerminal(30, 7);
		const tui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const activityStatus = new Container();
		const transcriptStatus = new TranscriptStatusIndicator(
			transcript,
			() => true,
			(text) => text,
		);
		const statusRegion = new StatusRegionComponent(activityStatus, transcriptStatus);
		const dock = new VStack([statusRegion, new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		if (!isViewportTUI(tui)) throw new Error("Expected fullscreen TUI");
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);

		tui.start();
		try {
			await terminal.waitForRender();
			const visibleText = () => terminal.getViewport().map(stripTerminalSequences);
			const idleViewportHeight = transcript.viewportHeight;
			expect(idleViewportHeight).toBe(4);
			expect(visibleText().some((line) => line.includes("↓"))).toBe(false);

			transcript.scrollBy(-1);
			await terminal.waitForRender();
			expect(transcript.viewportHeight).toBe(idleViewportHeight);
			expect(visibleText().some((line) => line.trimEnd() === "↓")).toBe(true);

			transcript.scrollBy(1);
			await terminal.waitForRender();
			expect(transcript.isFollowingEnd).toBe(true);
			expect(visibleText().some((line) => line.includes("↓"))).toBe(false);

			transcript.scrollBy(-1);
			await terminal.waitForRender();
			activityStatus.addChild({
				render: () => ["", " Working..."],
				invalidate: () => {},
			});
			tui.requestRender();
			await terminal.waitForRender();
			expect(transcript.viewportHeight).toBe(idleViewportHeight - 2);
			expect(visibleText().some((line) => line.trimEnd() === "↓ Working...")).toBe(true);

			transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
			tui.requestRender();
			await terminal.waitForRender();
			expect(visibleText().some((line) => line.trimEnd() === "↓ Working...")).toBe(true);

			transcript.scrollToEnd();
			await terminal.waitForRender();
			expect(visibleText().some((line) => line.includes("↓"))).toBe(false);
			expect(visibleText().some((line) => line.trimEnd() === " Working...")).toBe(true);

			transcript.scrollBy(-4);
			await terminal.waitForRender();
			expect(visibleText().some((line) => line.trimEnd() === "↓ Working...")).toBe(true);

			activityStatus.clear();
			tui.requestRender();
			await terminal.waitForRender();
			expect(transcript.viewportHeight).toBe(idleViewportHeight);
			expect(visibleText().some((line) => line.trimEnd() === "↓")).toBe(true);
			expect(visibleText().some((line) => line.includes("Working..."))).toBe(false);

			transcriptText.setText("line 1");
			tui.requestRender();
			await terminal.waitForRender();
			expect(transcript.isFollowingEnd).toBe(true);
			expect(visibleText().some((line) => line.includes("↓"))).toBe(false);
		} finally {
			tui.stop();
		}
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

type CopyCommandOptions = { flashConfirmation?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
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
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });
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

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });

		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	options: { tuiMode?: TuiMode };
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [tuiMode, expectedChildren] of [
			["regular", 1],
			["fullscreen", 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				options: { tuiMode },
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
