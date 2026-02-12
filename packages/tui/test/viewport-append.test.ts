import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class Lines implements Component {
	private lines: string[] = [];

	append(lines: string[]): void {
		this.lines.push(...lines);
	}

	render(width: number): string[] {
		return this.lines.map((line) => (line.length > width ? line.slice(0, width) : line.padEnd(width, " ")));
	}

	invalidate(): void {}
}

const waitForRenderTick = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("TUI append behavior", () => {
	it("keeps earlier content in scrollback after long PRE -> TOOL -> POST streaming", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const ui = new TUI(terminal);
		const lines = new Lines();

		ui.addChild(lines);
		ui.start();

		const stream = async (label: string, count: number): Promise<void> => {
			for (let i = 1; i <= count; i++) {
				lines.append([`${label} ${String(i).padStart(2, "0")}`]);
				ui.requestRender();
				await waitForRenderTick();
				await terminal.flush();
			}
		};

		lines.append(["HDR", "", "=== PRE ==="]);
		ui.requestRender();
		await waitForRenderTick();
		await terminal.flush();

		await stream("PRE", 18);

		lines.append(["", "--- TOOL ---", ""]);
		ui.requestRender();
		await waitForRenderTick();
		await terminal.flush();

		await stream("TOOL", 22);

		lines.append(["", "=== POST ==="]);
		ui.requestRender();
		await waitForRenderTick();
		await terminal.flush();

		await stream("POST", 6);

		await waitForRenderTick();
		await terminal.flush();

		const fullBuffer = terminal.getScrollBuffer().join("\n");

		assert.equal(fullBuffer.includes("=== PRE ==="), true);
		assert.equal(fullBuffer.includes("PRE 18"), true);
		assert.equal(fullBuffer.includes("TOOL 22"), true);
		assert.equal(fullBuffer.includes("=== POST ==="), true);
		assert.equal(fullBuffer.includes("POST 06"), true);

		ui.stop();
	});
});
