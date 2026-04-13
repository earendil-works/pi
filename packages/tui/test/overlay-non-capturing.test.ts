import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, Focusable } from "../src/tui.js";
import { TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class StaticOverlay implements Component {
	constructor(private lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

class FocusableOverlay implements Component, Focusable {
	focused = false;
	inputs: string[] = [];

	constructor(private lines: string[]) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI overlay non-capturing", () => {
	describe("focus management", () => {
		it("non-capturing overlay preserves focus on creation", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay, { nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(overlay.focused, false);
			} finally {
				tui.stop();
			}
		});

		it("focus() transfers focus to the overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, false);
				assert.strictEqual(overlay.focused, true);
				assert.strictEqual(handle.isFocused(), true);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() restores previous focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				handle.unfocus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(overlay.focused, false);
				assert.strictEqual(handle.isFocused(), false);
			} finally {
				tui.stop();
			}
		});

		it("setHidden(false) on non-capturing overlay does not auto-focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.setHidden(true);
				handle.setHidden(false);
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(overlay.focused, false);
			} finally {
				tui.stop();
			}
		});

		it("hide() when overlay is not focused does not change focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("hide() when focused restores focus correctly", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				handle.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(overlay.focused, false);
			} finally {
				tui.stop();
			}
		});

		it("capturing overlay removed with non-capturing below restores focus to editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const nonCapturing = new FocusableOverlay(["NC"]);
			const capturing = new FocusableOverlay(["CAP"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				const handle = tui.showOverlay(capturing);
				assert.strictEqual(capturing.focused, true);
				handle.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(nonCapturing.focused, false);
			} finally {
				tui.stop();
			}
		});

		it("sub-overlay cleanup then hideOverlay restores focus and input to editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const timer = new FocusableOverlay(["TIMER"]);
			const controller = new FocusableOverlay(["CTRL"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const timerHandle = tui.showOverlay(timer, { nonCapturing: true });
				tui.showOverlay(controller);
				assert.strictEqual(controller.focused, true);
				assert.strictEqual(editor.focused, false);
				timerHandle.hide();
				tui.hideOverlay();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(controller.focused, false);
				assert.strictEqual(timer.focused, false);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(controller.inputs, []);
				assert.deepStrictEqual(timer.inputs, []);
			} finally {
				tui.stop();
			}
		});

		it("microtask-deferred sub-overlay pattern (showExtensionCustom simulation) restores focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const timer = new FocusableOverlay(["TIMER"]);
			const controller = new FocusableOverlay(["CTRL"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				// Simulate showExtensionCustom: factory creates timer synchronously,
				// then .then() pushes controller as a microtask
				let timerHandle: ReturnType<typeof tui.showOverlay>;
				let doneFn: () => void;

				const overlayPromise = new Promise<void>((resolve) => {
					doneFn = () => {
						timerHandle.hide();
						tui.hideOverlay();
						resolve();
					};
					// Factory runs synchronously: creates timer sub-overlay
					timerHandle = tui.showOverlay(timer, { nonCapturing: true });
					// .then() runs as microtask — same as showExtensionCustom
					Promise.resolve(controller).then((c) => {
						tui.showOverlay(c);
					});
				});

				// Wait for .then() microtask and renders to settle
				await new Promise<void>((r) => setTimeout(r, 50));
				await renderAndFlush(tui, terminal);

				assert.strictEqual(controller.focused, true);
				assert.strictEqual(editor.focused, false);

				// Simulate Esc: cleanup + close (from inside handleInput)
				doneFn!();
				// Now await the promise (simulating showExtensionCustom resolving)
				await overlayPromise;
				await renderAndFlush(tui, terminal);

				assert.strictEqual(editor.focused, true, "editor should regain focus");
				assert.strictEqual(controller.focused, false);
				assert.strictEqual(timer.focused, false);

				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"], "editor should receive input after close");
				assert.deepStrictEqual(controller.inputs, []);
			} finally {
				tui.stop();
			}
		});

		it("handleInput redirection skips non-capturing overlays when focused overlay becomes invisible", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const fallbackCapturing = new FocusableOverlay(["FALLBACK"]);
			const nonCapturing = new FocusableOverlay(["NC"]);
			const primary = new FocusableOverlay(["PRIMARY"]);
			let isVisible = true;
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(fallbackCapturing);
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				tui.showOverlay(primary, { visible: () => isVisible });
				assert.strictEqual(primary.focused, true);
				isVisible = false;
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(primary.inputs, []);
				assert.deepStrictEqual(nonCapturing.inputs, []);
				assert.deepStrictEqual(fallbackCapturing.inputs, ["x"]);
				assert.strictEqual(fallbackCapturing.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("hideOverlay() does not reassign focus when topmost overlay is non-capturing", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const capturing = new FocusableOverlay(["CAP"]);
			const nonCapturing = new FocusableOverlay(["NC"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(capturing);
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				assert.strictEqual(capturing.focused, true);
				tui.hideOverlay();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(capturing.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("multiple capturing and non-capturing overlays restore focus through removals", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const c1 = new FocusableOverlay(["C1"]);
			const n1 = new FocusableOverlay(["N1"]);
			const c2 = new FocusableOverlay(["C2"]);
			const n2 = new FocusableOverlay(["N2"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const c1Handle = tui.showOverlay(c1);
				tui.showOverlay(n1, { nonCapturing: true });
				const c2Handle = tui.showOverlay(c2);
				tui.showOverlay(n2, { nonCapturing: true });
				assert.strictEqual(c2.focused, true);
				c2Handle.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(c1.focused, true);
				c1Handle.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("capturing overlay unfocus() on topmost capturing overlay falls back to preFocus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const capturing = new FocusableOverlay(["CAP"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(capturing);
				assert.strictEqual(capturing.focused, true);
				handle.unfocus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(capturing.focused, false);
			} finally {
				tui.stop();
			}
		});
	});

	describe("no-op guards", () => {
		it("focus() on hidden overlay is a no-op", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.setHidden(true);
				handle.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(handle.isFocused(), false);
			} finally {
				tui.stop();
			}
		});

		it("focus() after hide() is a no-op", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.hide();
				handle.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(handle.isFocused(), false);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() when overlay does not have focus is a no-op", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.unfocus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(overlay.focused, false);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() with null preFocus clears focus and does not route input back to overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const handle = tui.showOverlay(overlay);
				assert.strictEqual(overlay.focused, true);
				handle.unfocus();
				assert.strictEqual(overlay.focused, false);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, []);
				assert.strictEqual(handle.isFocused(), false);
			} finally {
				tui.stop();
			}
		});
	});

	describe("focus cycle prevention", () => {
		it("toggle focus between non-capturing overlays then unfocus returns to editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const a = new FocusableOverlay(["A"]);
			const b = new FocusableOverlay(["B"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(a, { nonCapturing: true });
				const bHandle = tui.showOverlay(b, { nonCapturing: true });
				aHandle.focus();
				bHandle.focus();
				aHandle.focus();
				aHandle.unfocus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(a.focused, false);
				assert.strictEqual(b.focused, false);
			} finally {
				tui.stop();
			}
		});
	});

	describe("rendering order", () => {
		it("focus() on already-focused overlay bumps visual order", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				aHandle.focus();
				tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				aHandle.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				assert.strictEqual(aHandle.isFocused(), true);
			} finally {
				tui.stop();
			}
		});

		it("default rendering order for overlapping overlays follows creation order", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
			} finally {
				tui.stop();
			}
		});

		it("focus() on lower overlay renders it on top", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const lower = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				lower.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
			} finally {
				tui.stop();
			}
		});

		it("focusing middle overlay places it on top while preserving others relative order", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const middle = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const top = tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				middle.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				middle.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				top.hide();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
			} finally {
				tui.stop();
			}
		});

		it("capturing overlay hidden and shown again renders on top after unhide", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const capturing = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1 });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				capturing.setHidden(true);
				tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				capturing.setHidden(false);
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
			} finally {
				tui.stop();
			}
		});

		it("unfocus() does not change visual order until another overlay is focused", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const a = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const b = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				a.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				a.unfocus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				b.focus();
				await renderAndFlush(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
			} finally {
				tui.stop();
			}
		});
	});
});
