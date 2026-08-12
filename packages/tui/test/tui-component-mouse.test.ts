import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Component, TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Component that records the mouse events it receives on its own rows. */
class MousePanel implements Component {
	readonly events: TuiMouseEvent[] = [];
	private readonly lines: string[];
	private readonly consume: boolean;

	constructor(lines: string[], consume = true) {
		this.lines = lines;
		this.consume = consume;
	}

	render(): string[] {
		return this.lines;
	}

	onMouse(event: TuiMouseEvent): boolean {
		this.events.push(event);
		return this.consume;
	}

	invalidate(): void {}
}

/** SGR press of the primary button at a 0-based cell. */
function press(x: number, y: number): string {
	return `\x1b[<0;${x + 1};${y + 1}M`;
}

/** SGR release of the primary button at a 0-based cell. */
function release(x: number, y: number): string {
	return `\x1b[<0;${x + 1};${y + 1}m`;
}

/** SGR wheel-up (button 64) at a 0-based cell. */
function wheelUp(x: number, y: number): string {
	return `\x1b[<64;${x + 1};${y + 1}M`;
}

describe("TuiAltScreen component mouse events", () => {
	it("reports coordinates relative to the component's layout box", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const panel = new MousePanel(["row a", "row b"]);
		tui.setLayoutRoot(new VStack([new Text("header", 0, 0), panel]));
		tui.start();
		await terminal.waitForRender();

		// Panel occupies screen rows 1 and 2; column 3 of row 2 is its (1, 3).
		terminal.sendInput(press(3, 2));
		await terminal.waitForRender();

		assert.strictEqual(panel.events.length, 1);
		assert.deepStrictEqual(panel.events[0], {
			type: "press",
			row: 1,
			col: 3,
			screenRow: 2,
			screenCol: 3,
			button: 0,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		});

		// The header row is not the panel's, so nothing is delivered.
		terminal.sendInput(press(3, 0));
		await terminal.waitForRender();
		assert.strictEqual(panel.events.length, 1);

		tui.stop();
	});

	it("delivers release and drag events after a consumed press", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const panel = new MousePanel(["row a", "row b"]);
		tui.setLayoutRoot(panel);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(1, 0));
		terminal.sendInput("\x1b[<32;3;1M");
		terminal.sendInput(release(2, 0));
		await terminal.waitForRender();

		assert.deepStrictEqual(
			panel.events.map((event) => event.type),
			["press", "drag", "release"],
		);

		tui.stop();
	});

	it("drops pointer motion with no button held", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const panel = new MousePanel(["row a", "row b"]);
		tui.setLayoutRoot(panel);
		tui.start();
		await terminal.waitForRender();

		// Button bits 3 with the motion bit set: hover, not a drag.
		terminal.sendInput("\x1b[<35;2;1M");
		await terminal.waitForRender();
		assert.strictEqual(panel.events.length, 0);

		tui.stop();
	});

	it("consumed wheel events do not scroll the view underneath", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const panel = new MousePanel(["panel"]);
		const transcript = new ScrollView(new Text(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")), {
			follow: "end",
			primary: true,
		});
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: "auto" },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		const scrollTop = transcript.scrollTop;
		terminal.sendInput(wheelUp(0, 3));
		await terminal.waitForRender();

		assert.deepStrictEqual(
			panel.events.map((event) => ({ type: event.type, wheel: event.wheel })),
			[{ type: "wheel", wheel: -1 }],
		);
		assert.strictEqual(transcript.scrollTop, scrollTop);

		tui.stop();
	});

	it("falls through to viewport scrolling when the component declines the event", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const panel = new MousePanel(["panel"], false);
		const transcript = new ScrollView(new Text(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")), {
			follow: "end",
			primary: true,
		});
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: "auto" },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		const scrollTop = transcript.scrollTop;
		terminal.sendInput(wheelUp(0, 3));
		await terminal.waitForRender();

		assert.strictEqual(panel.events.length, 1);
		assert.strictEqual(transcript.scrollTop, scrollTop - 1);

		tui.stop();
	});

	it("does not deliver events to rows scrolled out of a scroll view", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const panel = new MousePanel(["p1", "p2"]);
		const scrollView = new ScrollView(new VStack([panel, new Text("tail 1\ntail 2\ntail 3", 0, 0)]), {
			follow: "end",
			primary: true,
		});
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();

		// Following the end scrolls the panel's rows above the viewport.
		assert.ok(scrollView.scrollTop >= 2);
		for (let row = 0; row < 3; row++) {
			terminal.sendInput(press(0, row));
			terminal.sendInput(release(0, row));
		}
		await terminal.waitForRender();
		assert.strictEqual(panel.events.length, 0);

		scrollView.scrollToStart();
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(press(0, 0));
		await terminal.waitForRender();
		assert.strictEqual(panel.events.length, 1);
		assert.strictEqual(panel.events[0]?.row, 0);

		tui.stop();
	});
});
