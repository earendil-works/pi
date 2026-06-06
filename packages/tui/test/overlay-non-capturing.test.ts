import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, Focusable } from "../src/tui.ts";
import { Container, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

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
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

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

		it("removed focused child overlay does not become parent overlay fallback", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const child = new FocusableOverlay(["CHILD"]);
			const parent = new FocusableOverlay(["PARENT"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const childHandle = tui.showOverlay(child, { nonCapturing: true });
				childHandle.focus();
				const parentHandle = tui.showOverlay(parent);
				assert.strictEqual(parent.focused, true);

				childHandle.hide();
				parentHandle.hide();
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);

				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(child.inputs, []);
				assert.deepStrictEqual(parent.inputs, []);
				assert.strictEqual(editor.focused, true);
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
				let timerHandle: ReturnType<typeof tui.showOverlay> | null = null;
				let doneFn: () => void = () => {
					throw new Error("doneFn was not initialized");
				};

				const overlayPromise = new Promise<void>((resolve) => {
					doneFn = () => {
						if (!timerHandle) throw new Error("timerHandle was not initialized");
						timerHandle.hide();
						tui.hideOverlay();
						resolve();
					};
					timerHandle = tui.showOverlay(timer, { nonCapturing: true });
					// .then() runs as microtask — same as showExtensionCustom
					Promise.resolve(controller).then((c) => {
						tui.showOverlay(c);
					});
				});

				await Promise.resolve();
				await renderAndFlush(tui, terminal);

				assert.strictEqual(controller.focused, true);
				assert.strictEqual(editor.focused, false);

				// Simulate Esc: cleanup + close (from inside handleInput)
				doneFn();
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

		it("active base focus replacement receives close input before overlay restore", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") {
					tui.setFocus(replacement);
				}
			};
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") {
					tui.setFocus(editor);
				}
			};
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay);
				assert.strictEqual(overlay.focused, true);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				assert.strictEqual(replacement.focused, true);

				terminal.sendInput("\r");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				assert.deepStrictEqual(overlay.inputs, ["b"]);
				assert.strictEqual(overlay.focused, true);

				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, ["b", "x"]);
			} finally {
				tui.stop();
			}
		});

		it("active replacement still receives input when it is another overlay preFocus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const passive = new FocusableOverlay(["PASSIVE"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") {
					tui.setFocus(replacement);
				}
			};
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") {
					tui.setFocus(editor);
				}
			};
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.setFocus(replacement);
				tui.showOverlay(passive, { nonCapturing: true });
				tui.setFocus(editor);
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				assert.strictEqual(replacement.focused, true);

				terminal.sendInput("1");
				terminal.sendInput("\r");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(replacement.inputs, ["1", "\r"]);
				assert.deepStrictEqual(overlay.inputs, ["b"]);
				assert.strictEqual(overlay.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("blocked replacement can move focus internally before overlay restore", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const base = new Container();
			const editor = new FocusableOverlay(["EDITOR"]);
			const firstReplacement = new FocusableOverlay(["FIRST"]);
			const secondReplacement = new FocusableOverlay(["SECOND"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") tui.setFocus(firstReplacement);
			};
			firstReplacement.handleInput = (data: string) => {
				firstReplacement.inputs.push(data);
				if (data === "n") tui.setFocus(secondReplacement);
			};
			secondReplacement.handleInput = (data: string) => {
				secondReplacement.inputs.push(data);
				if (data === "\r") {
					base.clear();
					base.addChild(editor);
					tui.setFocus(editor);
				}
			};
			base.addChild(editor);
			base.addChild(firstReplacement);
			base.addChild(secondReplacement);
			tui.addChild(base);
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("n");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("2");
				terminal.sendInput("\r");
				await renderAndFlush(tui, terminal);

				assert.deepStrictEqual(overlay.inputs, ["b"]);
				assert.deepStrictEqual(firstReplacement.inputs, ["n"]);
				assert.deepStrictEqual(secondReplacement.inputs, ["2", "\r"]);
				assert.strictEqual(overlay.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("removed replacement restores overlay even when overlay preFocus differs from next focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const base = new Container();
			const editor = new FocusableOverlay(["EDITOR"]);
			const palette = new FocusableOverlay(["PALETTE"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") tui.setFocus(replacement);
			};
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") {
					base.clear();
					base.addChild(editor);
					tui.setFocus(editor);
				}
			};
			base.addChild(editor);
			base.addChild(palette);
			base.addChild(replacement);
			tui.addChild(base);
			tui.setFocus(palette);
			tui.start();
			try {
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("\r");
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);

				assert.deepStrictEqual(overlay.inputs, ["b", "x"]);
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				assert.deepStrictEqual(editor.inputs, []);
				assert.strictEqual(overlay.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("unfocus target releases a blocked overlay while replacement remains focused", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const fallback = new FocusableOverlay(["FALLBACK"]);
			const target = new FocusableOverlay(["TARGET"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") tui.setFocus(fallback);
			};
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const overlayHandle = tui.showOverlay(overlay);
				overlay.handleInput = (data: string) => {
					overlay.inputs.push(data);
					if (data === "b") {
						tui.setFocus(replacement);
						overlayHandle.unfocus({ target });
					}
				};

				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				assert.strictEqual(replacement.focused, true);
				terminal.sendInput("\r");
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);

				assert.deepStrictEqual(overlay.inputs, ["b"]);
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				assert.deepStrictEqual(fallback.inputs, []);
				assert.deepStrictEqual(target.inputs, ["x"]);
			} finally {
				tui.stop();
			}
		});

		it("handleInput restores focus to a visible focused overlay after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay);
				assert.strictEqual(overlay.focused, true);
				tui.setFocus(replacement);
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, ["x"]);
				assert.deepStrictEqual(editor.inputs, []);
				assert.strictEqual(overlay.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("handleInput restores focus to explicitly focused raw sub-overlay after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const controller = new FocusableOverlay(["CONTROLLER"]);
			const subOverlay = new FocusableOverlay(["SUB"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(controller);
				const subHandle = tui.showOverlay(subOverlay, { nonCapturing: true });
				subHandle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(subOverlay.inputs, ["x"]);
				assert.deepStrictEqual(controller.inputs, []);
				assert.deepStrictEqual(editor.inputs, []);
			} finally {
				tui.stop();
			}
		});

		it("passive non-capturing overlay does not regain input after base focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const passive = new FocusableOverlay(["PASSIVE"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(passive, { nonCapturing: true });
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(passive.inputs, []);
				assert.strictEqual(editor.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("explicitly focused non-capturing overlay regains input after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["NC"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, ["x"]);
				assert.deepStrictEqual(editor.inputs, []);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() prevents visible overlay from regaining input", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay);
				handle.unfocus();
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(overlay.inputs, []);
				assert.strictEqual(editor.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("setFocus(null) explicitly clears visible overlay restore", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(overlay);
				tui.setFocus(null);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, []);
				assert.strictEqual(overlay.focused, false);
			} finally {
				tui.stop();
			}
		});

		it("blocked replacement setFocus(null) resumes the visible overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") tui.setFocus(null);
			};
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") tui.setFocus(replacement);
			};
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("\r");
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				assert.deepStrictEqual(overlay.inputs, ["b", "x"]);
				assert.strictEqual(overlay.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("temporarily invisible focused overlay falls back without losing restore eligibility", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			let visible = true;
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay, { visible: () => visible });
				tui.setFocus(editor);
				visible = false;
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(overlay.inputs, []);
				visible = true;
				terminal.sendInput("y");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(overlay.inputs, ["y"]);
			} finally {
				tui.stop();
			}
		});

		it("temporarily invisible focused overlay with null preFocus restores when visible again", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			let visible = true;
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(overlay, { visible: () => visible });
				visible = false;
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, []);
				visible = true;
				terminal.sendInput("y");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, ["y"]);
			} finally {
				tui.stop();
			}
		});

		it("cyclic overlay preFocus ancestry does not hang focus changes", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(overlay);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(overlay.inputs, []);
			} finally {
				tui.stop();
			}
		});

		it("handleInput restores the focus-order top overlay after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const lower = new FocusableOverlay(["LOWER"]);
			const upper = new FocusableOverlay(["UPPER"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const lowerHandle = tui.showOverlay(lower);
				tui.showOverlay(upper);
				lowerHandle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(lower.inputs, ["x"]);
				assert.deepStrictEqual(upper.inputs, []);
				assert.deepStrictEqual(editor.inputs, []);
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

		it("explicit unfocus target supports cycling between three overlays and editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const a = new FocusableOverlay(["A"]);
			const b = new FocusableOverlay(["B"]);
			const c = new FocusableOverlay(["C"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(a);
				const bHandle = tui.showOverlay(b);
				const cHandle = tui.showOverlay(c);

				aHandle.focus();
				terminal.sendInput("a");
				await renderAndFlush(tui, terminal);
				bHandle.focus();
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				cHandle.focus();
				terminal.sendInput("c");
				await renderAndFlush(tui, terminal);
				cHandle.unfocus({ target: editor });
				terminal.sendInput("e");
				await renderAndFlush(tui, terminal);
				aHandle.focus();
				terminal.sendInput("A");
				await renderAndFlush(tui, terminal);
				aHandle.unfocus({ target: editor });
				terminal.sendInput("E");
				await renderAndFlush(tui, terminal);

				assert.deepStrictEqual(a.inputs, ["a", "A"]);
				assert.deepStrictEqual(b.inputs, ["b"]);
				assert.deepStrictEqual(c.inputs, ["c"]);
				assert.deepStrictEqual(editor.inputs, ["e", "E"]);
				assert.strictEqual(editor.focused, true);
			} finally {
				tui.stop();
			}
		});

		it("explicit null unfocus target clears focus without restoring overlays", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const handle = tui.showOverlay(overlay);
				handle.unfocus({ target: null });
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(overlay.inputs, []);
				assert.strictEqual(handle.isFocused(), false);
			} finally {
				tui.stop();
			}
		});

		it("hiding focused overlay falls back to next visual-frontmost overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const a = new FocusableOverlay(["A"]);
			const b = new FocusableOverlay(["B"]);
			const c = new FocusableOverlay(["C"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(a);
				const bHandle = tui.showOverlay(b);
				tui.showOverlay(c);
				aHandle.focus();
				bHandle.focus();
				bHandle.setHidden(true);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				assert.deepStrictEqual(a.inputs, ["x"]);
				assert.deepStrictEqual(c.inputs, []);
				assert.strictEqual(a.focused, true);
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
