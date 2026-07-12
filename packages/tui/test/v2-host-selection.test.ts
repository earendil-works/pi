import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import * as v2 from "../src/v2/index.ts";
import { V2TUIHost } from "../src/v2/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("v2 entry point", () => {
	it("re-exports the Phase-A primitives and the host from ./v2", () => {
		for (const name of [
			"BandLayout",
			"CellBuffer",
			"LinkTable",
			"FrameScheduler",
			"LedgerStore",
			"ConservativeMarkdownFrontier",
			"CompletedLineFrontier",
			"Signal",
			"StyleTable",
			"DefaultTextLayout",
			"TextModel",
			"V2TUIHost",
		]) {
			assert.ok(name in v2, `expected ./v2 to export ${name}`);
		}
	});

	it("exposes V2TUIHost as a concrete TUI subclass so extension TUI callbacks keep working", () => {
		const host = new V2TUIHost(new VirtualTerminal(40, 10));
		assert.ok(host instanceof TUI, "V2TUIHost must be an instance of the concrete TUI class");
		assert.strictEqual(host.renderMode, "v2");
	});
});

describe("v1 flag-off rendering stays unchanged", () => {
	it("renders the canonical viewport through the default TUI", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		assert.ok(!(tui instanceof V2TUIHost), "the default renderer must not be the v2 host");
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", "", ""]);
		tui.stop();
	});
});
