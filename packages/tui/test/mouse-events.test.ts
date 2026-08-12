import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Component, ComponentMouseEvent, ComponentMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Component that records mouse events and handles them.
 */
class MouseComponent implements Component {
	readonly events: ComponentMouseEvent[] = [];
	private readonly lines: string[];
	private readonly handle: (event: ComponentMouseEvent) => ComponentMouseEventResult | undefined;

	constructor(
		lines: string[],
		handle: (event: ComponentMouseEvent) => ComponentMouseEventResult | undefined = () => ({ handled: true }),
	) {
		this.lines = lines;
		this.handle = handle;
	}
	onMouse(event: ComponentMouseEvent): ComponentMouseEventResult | undefined {
		this.events.push(event);
		return this.handle(event);
	}

	render(width: number): string[] {
		return this.lines.map((line) => line.slice(0, width));
	}

	invalidate(): void {}
}

/** Layout: scrollable transcript on top, mouse target docked below. */
function buildTui(terminal: VirtualTerminal, target: Component) {
	const transcriptText = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
	const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: target, basis: "auto", minSize: 1 },
		]),
	);
	return { tui, transcript, transcriptText };
}

describe("TuiAltScreen component mouse events", () => {
	it("delivers wheel events to a layout component and skips viewport scrolling", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const target = new MouseComponent(["target"]);
		const { tui, transcript } = buildTui(terminal, target);
		tui.start();
		await terminal.waitForRender();
		const before = tui.viewportTop;

		// Wheel up at row 6 (1-based) = the docked target's only row.
		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();

		assert.strictEqual(target.events.length, 1);
		assert.deepStrictEqual(
			{ ...target.events[0] },
			{ button: 64, x: 0, y: 5, row: 0, col: 0, release: false, wheel: -1 },
		);
		assert.strictEqual(tui.viewportTop, before, "viewport must not scroll when a component handles the wheel");
		assert.strictEqual(transcript.isFollowingEnd, true);
		tui.stop();
	});

	it("delivers wheel events with box-relative coordinates", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const target = new MouseComponent(["first", "second"]);
		const { tui } = buildTui(terminal, target);
		tui.start();
		await terminal.waitForRender();

		// Wheel down at row 6, column 5 → target row 1, col 4.
		terminal.sendInput("\x1b[<65;5;6M");
		await terminal.waitForRender();

		assert.strictEqual(target.events.length, 1);
		assert.strictEqual(target.events[0]?.wheel, 1);
		assert.strictEqual(target.events[0]?.row, 1);
		assert.strictEqual(target.events[0]?.col, 4);
		tui.stop();
	});

	it("falls through to viewport scrolling when the component does not handle", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const target = new MouseComponent(["target"], () => undefined);
		const { tui } = buildTui(terminal, target);
		tui.start();
		await terminal.waitForRender();
		const before = tui.viewportTop;

		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();

		assert.strictEqual(target.events.length, 1, "component still observes the event");
		assert.strictEqual(tui.viewportTop, before - 1, "unhandled wheel falls through to the viewport");
		tui.stop();
	});

	it("delivers click press and release to a layout component", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const target = new MouseComponent(["target"]);
		const { tui } = buildTui(terminal, target);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;6M");
		terminal.sendInput("\x1b[<0;3;6m");
		await terminal.waitForRender();

		assert.strictEqual(target.events.length, 2);
		assert.strictEqual(target.events[0]?.release, false);
		assert.strictEqual(target.events[0]?.button, 0);
		assert.strictEqual(target.events[1]?.release, true);
		assert.strictEqual(target.events[1]?.col, 2);
		tui.stop();
	});

	it("delivers events to the frontmost overlay before the layout beneath it", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const overlay = new MouseComponent(["overlay"]);
		const layoutTarget = new MouseComponent(["target"]);
		const { tui } = buildTui(terminal, layoutTarget);
		tui.showOverlay(overlay, { anchor: "top-left", width: 10, margin: 1 });
		tui.start();
		await terminal.waitForRender();

		// Overlay occupies row 1, col 1..10. Click inside it.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();

		assert.strictEqual(overlay.events.length, 2, "overlay receives the click");
		assert.strictEqual(overlay.events[0]?.row, 0);
		assert.strictEqual(overlay.events[0]?.col, 0);
		assert.strictEqual(layoutTarget.events.length, 0, "layout beneath the overlay must not receive it");
		tui.stop();
	});

	it("delivers wheel to a focused overlay via onMouse instead of handleInput", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const overlay = new MouseComponent(["overlay"]);
		const { tui, transcript } = buildTui(terminal, new MouseComponent(["target"]));
		tui.showOverlay(overlay, { anchor: "bottom-center", width: 10, margin: 1 });
		tui.start();
		await terminal.waitForRender();
		const before = tui.viewportTop;

		// Bottom-center overlay in a 20x6 terminal: col 5..15, row 4.
		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();

		assert.strictEqual(overlay.events.length, 1);
		assert.strictEqual(overlay.events[0]?.wheel, -1);
		assert.strictEqual(overlay.events[0]?.row, 0);
		assert.strictEqual(overlay.events[0]?.col, 4);
		assert.strictEqual(tui.viewportTop, before, "viewport stays put: overlay handled the wheel");
		assert.strictEqual(transcript.isFollowingEnd, true);
		tui.stop();
	});
});
