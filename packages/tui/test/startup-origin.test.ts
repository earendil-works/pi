import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import { TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

describe("TUI startup origin", () => {
	it("clears existing terminal content before the first render so row mapping starts at the top", async () => {
		const terminal = new VirtualTerminal(30, 8);
		terminal.write("shell prompt\r\ncommand output\r\n");
		await terminal.flush();

		const ui = new TUI(terminal);
		ui.addChild(new Text("line1\nline2", 0, 0));
		ui.start();
		await terminal.flush();

		const viewport = terminal.getViewport().map((line) => line.trimEnd());
		assert.equal(viewport[0], "line1");
		assert.equal(viewport[1], "line2");
		assert.equal(
			viewport.includes("shell prompt"),
			false,
			"expected startup render to clear pre-existing terminal content from the visible viewport",
		);
	});
});
