import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MutableLines implements Component {
	public lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

// Regression: a dynamic element that lives ABOVE the visible viewport (e.g. a pet
// heartbeat bubble, or any non-latest streamed line) used to force a full screen
// redraw — \x1b[2J\x1b[H plus \x1b[3J (clear-scrollback). That wipes terminal
// scrollback and yanks the view, which users feel as "刷新置顶" (jump-to-top /
// lost history) — most visible when they've scrolled up to read history and a
// mid-stream element updates. Differential rendering only needs to touch the
// visible viewport; scrollback lines are historical snapshots and must not force
// a full clear.
describe("above-viewport change must not nuke scrollback", () => {
	it("change entirely in scrollback: no clear-screen, no clear-scrollback", async () => {
		const vt = new VirtualTerminal(40, 10);
		const writes: string[] = [];
		const origWrite = vt.write.bind(vt);
		vt.write = (d: string) => {
			writes.push(d);
			origWrite(d);
		};

		const tui = new TUI(vt);
		const content = new MutableLines(Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}`));
		tui.addChild(content);
		tui.start();
		await vt.waitForRender();
		// viewport now shows L20..L29 (viewportTop = 30 - 10 = 20)
		writes.length = 0;

		// Change a line deep in scrollback (index 5 < 20) — invisible to user.
		content.lines[5] = "CHANGED-L05";
		tui.requestRender();
		await vt.waitForRender();

		const all = writes.join("");
		assert.ok(!all.includes("\x1b[3J"), "must NOT clear scrollback");
		assert.ok(!all.includes("\x1b[2J"), "must NOT full-clear screen");
		// Viewport unchanged — latest content still at bottom.
		const vp = vt.getViewport();
		assert.ok(
			vp.some((l) => l.includes("L29")),
			"latest line still visible",
		);
		tui.stop();
	});

	it("change spanning scrollback + viewport: only visible part repainted, scrollback kept", async () => {
		const vt = new VirtualTerminal(40, 10);
		const writes: string[] = [];
		const origWrite = vt.write.bind(vt);
		vt.write = (d: string) => {
			writes.push(d);
			origWrite(d);
		};

		const tui = new TUI(vt);
		const content = new MutableLines(Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}`));
		tui.addChild(content);
		tui.start();
		await vt.waitForRender();
		writes.length = 0;

		// Change index 5 (scrollback) AND index 25 (visible: viewportTop=20).
		content.lines[5] = "CHANGED-L05";
		content.lines[25] = "CHANGED-L25";
		tui.requestRender();
		await vt.waitForRender();

		const all = writes.join("");
		assert.ok(!all.includes("\x1b[3J"), "must NOT clear scrollback");
		// Visible change DID get painted.
		const vp = vt.getViewport();
		assert.ok(
			vp.some((l) => l.includes("CHANGED-L25")),
			"visible change painted",
		);
		tui.stop();
	});

	it("scrollback change + append: viewport follows growth, no scrollback clear", async () => {
		const vt = new VirtualTerminal(40, 10);
		const writes: string[] = [];
		const origWrite = vt.write.bind(vt);
		vt.write = (d: string) => {
			writes.push(d);
			origWrite(d);
		};

		const tui = new TUI(vt);
		const content = new MutableLines(Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}`));
		tui.addChild(content);
		tui.start();
		await vt.waitForRender();
		writes.length = 0;

		// Change index 5 (scrollback) AND append 5 new lines (content grows).
		content.lines[5] = "CHANGED-L05";
		for (let i = 30; i < 35; i++) content.lines.push(`L${String(i).padStart(2, "0")}`);
		tui.requestRender();
		await vt.waitForRender();

		const all = writes.join("");
		assert.ok(!all.includes("\x1b[3J"), "must NOT clear scrollback");
		// Viewport followed the growth — the appended tail is visible.
		const vp = vt.getViewport();
		assert.ok(
			vp.some((l) => l.includes("L34")),
			"appended tail visible after growth",
		);
		tui.stop();
	});
});
