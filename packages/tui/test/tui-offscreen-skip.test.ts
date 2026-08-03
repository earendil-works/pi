import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe("TUI off-screen change skip", () => {
	it("does not full-clear when only lines above the viewport change", async () => {
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-offscreen-"));
		try {
			await withEnv({ PI_DEBUG_REDRAW: "1" }, async () => {
				const height = 6;
				const terminal = new LoggingVirtualTerminal(40, height);
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);

				// 20 lines → viewportTop = 14 on a height-6 terminal
				component.lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
				tui.start();
				await terminal.waitForRender();
				const afterFirst = tui.fullRedraws;
				terminal.clearWrites();

				// Change only an off-screen line (index 0); length unchanged.
				component.lines = ["XCHANGED", ...Array.from({ length: 19 }, (_, i) => `L${i + 1}`)];
				tui.requestRender();
				await terminal.waitForRender();

				assert.strictEqual(
					tui.fullRedraws,
					afterFirst,
					"off-screen same-window change must not increment fullRedraws",
				);
				const writes = terminal.getWrites();
				assert.ok(!writes.includes("\x1b[2J"), "must not clear the screen");
				assert.ok(!writes.includes("\x1b[3J"), "must not clear scrollback");

				const log = readFileSync(join(logDir, "pi-debug.log"), "utf-8");
				assert.match(log, /skip offscreen/);
				tui.stop();
			});
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("differentially updates when a visible line also changes without full-clear", async () => {
		const height = 6;
		const terminal = new LoggingVirtualTerminal(40, height);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
		tui.start();
		await terminal.waitForRender();
		const afterFirst = tui.fullRedraws;
		terminal.clearWrites();

		// Change off-screen line 0 and last visible line (index 19)
		const next = Array.from({ length: 20 }, (_, i) => `L${i}`);
		next[0] = "OFF";
		next[19] = "VIS";
		component.lines = next;
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, afterFirst, "clamp path must not full-clear");
		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[2J"), "must not full clear screen");
		assert.ok(writes.includes("VIS") || writes.includes("\x1b[2K"), "visible row should be rewritten");
		tui.stop();
	});

	it("still full-clears when line count changes with an off-screen first change", async () => {
		const height = 6;
		const terminal = new LoggingVirtualTerminal(40, height);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
		tui.start();
		await terminal.waitForRender();
		const afterFirst = tui.fullRedraws;

		// Insert at top → length change, firstChanged above viewport
		component.lines = ["NEW", ...Array.from({ length: 20 }, (_, i) => `L${i}`)];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > afterFirst, "length-changing off-screen edit must full-clear");
		tui.stop();
	});

	it("full-clears when a kitty image straddles the viewport top", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-kitty-straddle-"));
		try {
			await withEnv({ PI_DEBUG_REDRAW: "1" }, async () => {
				const height = 6;
				const terminal = new LoggingVirtualTerminal(40, height);
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);

				// Kitty image with r=2. On height=6 with 20 lines, viewportTop=14.
				// Place header at index 13 so reserved rows 13-14 straddle the fold.
				const image = new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ maxWidthCells: 2 },
					{ widthPx: 20, heightPx: 20 },
				);
				const imageLines = image.render(40);
				assert.ok(imageLines.length >= 2, "image should reserve multiple rows");

				const head = Array.from({ length: 13 }, (_, i) => `H${i}`);
				const tailPad = Math.max(0, 20 - head.length - imageLines.length);
				const tail = Array.from({ length: tailPad }, (_, i) => `T${i}`);
				const base = [...head, ...imageLines, ...tail];
				// Keep length stable and large enough that viewportTop > image header index
				while (base.length < 20) base.push(`P${base.length}`);
				assert.strictEqual(base.length, 20);
				// Sanity: header index 13 < viewportTop 14 <= blockEnd 14
				assert.ok(head.length === 13);

				component.lines = base;
				tui.start();
				await terminal.waitForRender();
				const afterFirst = tui.fullRedraws;
				terminal.clearWrites();

				// Off-screen + visible change while straddling image is present
				const next = [...base];
				next[0] = "OFF";
				next[next.length - 1] = "VIS";
				component.lines = next;
				tui.requestRender();
				await terminal.waitForRender();

				assert.ok(tui.fullRedraws > afterFirst, "kitty-straddling change must full-clear to avoid ghost images");
				const log = readFileSync(join(logDir, "pi-debug.log"), "utf-8");
				assert.match(log, /firstChanged < viewportTop/);
				tui.stop();
			});
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			rmSync(logDir, { recursive: true, force: true });
		}
	});
});
