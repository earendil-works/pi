import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { type Component, REVERSE_VIDEO_ON, TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	allWrites(): string {
		return this.writes.join("");
	}
}

/** Container that focuses its child directly, mirroring the embedded-selector pattern. */
class FocusingContainer implements Component {
	readonly child: Input;

	constructor() {
		this.child = new Input();
		// Bypasses tui.setFocus() on purpose: several real containers set
		// child.focused = true directly and hold no TUI reference.
		this.child.focused = true;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	invalidate(): void {}
}

async function withEnv(value: string | undefined, run: () => void): Promise<void> {
	const previous = process.env.PI_HARDWARE_CURSOR;
	if (value === undefined) delete process.env.PI_HARDWARE_CURSOR;
	else process.env.PI_HARDWARE_CURSOR = value;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env.PI_HARDWARE_CURSOR;
		else process.env.PI_HARDWARE_CURSOR = previous;
	}
}

describe("hardware cursor default", () => {
	it("is on when PI_HARDWARE_CURSOR is unset", async () => {
		await withEnv(undefined, () => {
			assert.equal(new TUI(new VirtualTerminal()).getShowHardwareCursor(), true);
		});
	});

	it("is on when PI_HARDWARE_CURSOR=1", async () => {
		await withEnv("1", () => {
			assert.equal(new TUI(new VirtualTerminal()).getShowHardwareCursor(), true);
		});
	});

	it("is off when PI_HARDWARE_CURSOR=0", async () => {
		await withEnv("0", () => {
			assert.equal(new TUI(new VirtualTerminal()).getShowHardwareCursor(), false);
		});
	});

	it("honors an explicit constructor override over the env var", async () => {
		await withEnv("0", () => {
			assert.equal(new TUI(new VirtualTerminal(), true).getShowHardwareCursor(), true);
		});
		await withEnv("1", () => {
			assert.equal(new TUI(new VirtualTerminal(), false).getShowHardwareCursor(), false);
		});
	});
});

describe("hardware cursor rendering", () => {
	it("unwraps the reverse-video cursor cell when the hardware cursor is on", async () => {
		const terminal = new RecordingTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("abc");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		assert.ok(
			!terminal.allWrites().includes(REVERSE_VIDEO_ON),
			"hardware cursor on should not paint a reverse-video cursor",
		);
		tui.stop();
	});

	it("keeps the reverse-video fallback when the hardware cursor is off", async () => {
		const terminal = new RecordingTerminal(40, 6);
		const tui = new TUI(terminal, false);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("abc");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		assert.ok(
			terminal.allWrites().includes(REVERSE_VIDEO_ON),
			"hardware cursor off should keep the reverse-video fallback",
		);
		tui.stop();
	});

	it("unwraps embedded inputs focused directly by a container (H1 regression)", async () => {
		const terminal = new RecordingTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const container = new FocusingContainer();
		container.child.setValue("hello");
		tui.addChild(container);
		tui.start();
		await terminal.waitForRender();

		assert.ok(
			!terminal.allWrites().includes(REVERSE_VIDEO_ON),
			"embedded input focused outside setFocus should still be unwrapped",
		);
		tui.stop();
	});

	it("preserves rendered width in both cursor modes", () => {
		for (const hardwareCursor of [true, false]) {
			const tui = new TUI(new VirtualTerminal(20, 6), hardwareCursor);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("hello");
			tui.setFocus(editor);
			for (const line of editor.render(20)) {
				assert.equal(visibleWidth(line), 20, `width should be 20 (hardwareCursor=${hardwareCursor})`);
			}
		}
	});
});

describe("hardware cursor DECSCUSR wiring", () => {
	it("emits a steady block on start when the hardware cursor is on", () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		tui.start();
		assert.ok(terminal.cursorStyleWrites.includes("steady-block"), "start should set a steady block cursor");
		tui.stop();
	});

	it("does not change cursor style on start when the hardware cursor is off", () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal, false);
		tui.start();
		assert.deepEqual(terminal.cursorStyleWrites, [], "start should not emit DECSCUSR when hardware cursor is off");
		tui.stop();
	});

	it("restores the default cursor style on stop when the hardware cursor is on", () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		tui.start();
		tui.stop();
		assert.equal(terminal.cursorStyleWrites.at(-1), "default", "stop should restore the default cursor style");
	});

	it("emits DECSCUSR when toggled via setShowHardwareCursor", () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal, false);
		tui.setShowHardwareCursor(true);
		assert.equal(terminal.cursorStyleWrites.at(-1), "steady-block", "enabling should set a steady block");
		tui.setShowHardwareCursor(false);
		assert.equal(terminal.cursorStyleWrites.at(-1), "default", "disabling should restore the default");
	});
});
