import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { extractSegments, normalizeTerminalOutput, sliceWithWidth, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FullViewportContent implements Component {
	render(width: number): string[] {
		return ["base 0", "base 1", "base 2"].map((line) => line.padEnd(width));
	}

	invalidate(): void {}
}

class CapturingVirtualTerminal extends VirtualTerminal {
	private output = "";

	override write(data: string): void {
		this.output += data;
		super.write(data);
	}

	getOutput(): string {
		return this.output;
	}
}

class TabStatusOverlay implements Component {
	render(): string[] {
		return ["\tX"];
	}

	invalidate(): void {}
}

describe("tab width accounting", () => {
	it("keeps slice helper widths consistent with visible width", () => {
		const text = "out 192M\t.pi/skill-tests/results-ha";
		const slice = sliceWithWidth(text, 0, 10, true);

		assert.strictEqual(slice.text, "out 192M");
		assert.strictEqual(slice.width, 8);
		assert.strictEqual(visibleWidth(slice.text), slice.width);
	});

	it("keeps overlay segment widths consistent with visible width", () => {
		const text = "out 192M\t.pi/skill-tests/results-ha";
		const segments = extractSegments(text, 10, 13, 10, true);

		assert.strictEqual(segments.before, "out 192M");
		assert.strictEqual(segments.beforeWidth, 8);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);

		const tabFits = extractSegments(text, 11, 13, 10, true);
		assert.strictEqual(tabFits.before, "out 192M\t");
		assert.strictEqual(tabFits.beforeWidth, 11);
		assert.strictEqual(visibleWidth(tabFits.before), tabFits.beforeWidth);
	});

	it("keeps tabs inside terminal control sequences byte-identical", () => {
		const controlSequences = [
			"\x1b]8;;https://example.test/a\tb\x07",
			"\x1b]0;window\ttitle\x1b\\",
			"\x1b_payload\tdata\x1b\\",
		];

		for (const controlSequence of controlSequences) {
			assert.strictEqual(normalizeTerminalOutput(`${controlSequence}label\ttext`), `${controlSequence}label   text`);
		}
	});

	it("keeps tab-containing overlays on one physical terminal row", async () => {
		const terminal = new CapturingVirtualTerminal(16, 3);
		const tui = new TUI(terminal);
		tui.addChild(new FullViewportContent());
		tui.showOverlay(new TabStatusOverlay(), { width: 4, row: 1, col: 4 });
		tui.start();

		try {
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport(), ["base 0          ", "base   X        ", "base 2          "]);
			assert.ok(!terminal.getOutput().includes("\t"));
		} finally {
			tui.stop();
		}
	});
});
