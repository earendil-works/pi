import assert from "node:assert";
import { describe, it } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import { type Component, TUI } from "../src/tui.ts";
import { V2TUIHost } from "../src/v2/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Legacy (non-Kitty) input sequences so the global keybindings resolve against raw control/letter bytes,
// matching how the accepted viewer test drives keys.
setKittyProtocolActive(false);

const CTRL_R = "\x12"; // tui.history.open
const ESC = "\x1b"; // tui.history.close
const CTRL_C = "\x03"; // tui.history.close

// Alt-screen + mode sequences the pager owns; asserting on raw writes proves real terminal handoff.
const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const AUTOWRAP_OFF = "\x1b[?7l";
const AUTOWRAP_ON = "\x1b[?7h";
const SHOW_CURSOR = "\x1b[?25h";

/** A stand-in for the coding agent's chatContainer: a mutable, width-agnostic transcript of logical lines. */
class Transcript implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** VirtualTerminal that also records every raw byte written, for alt-screen / mode assertions. */
class RecordingTerminal extends VirtualTerminal {
	raw = "";
	override write(data: string): void {
		this.raw += data;
		super.write(data);
	}
}

function viewportText(terminal: VirtualTerminal): string {
	return terminal.getViewport().join("\n");
}

/** Non-empty, right-trimmed lines across the whole active buffer (scrollback + viewport), in order. */
function bufferLines(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

describe("V2TUIHost full-history pager wiring", () => {
	it("opens on ctrl+r through the host, reaches history above the visible tail, and returns to live", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(terminal);
		const transcript = new Transcript(Array.from({ length: 30 }, (_, i) => `L${i}`));
		host.addChild(transcript);
		host.start();
		await terminal.waitForRender();

		// The oldest rows have scrolled above the 8-row viewport before the pager opens.
		const liveViewport = viewportText(terminal);
		assert.ok(!liveViewport.includes("L0"), `L0 must be above the visible tail pre-open; got:\n${liveViewport}`);
		const scrollbackBeforeOpen = bufferLines(terminal);

		// Open via the discoverable keybinding; the host captures it before the editor.
		terminal.sendInput(CTRL_R);
		assert.strictEqual(host.historyOpen, true, "ctrl+r must open the pager through the host");
		assert.ok(terminal.raw.includes(ALT_ENTER), "host must enter the alternate screen");
		assert.ok(terminal.raw.includes(AUTOWRAP_OFF), "host must disable autowrap while the pager owns the screen");
		await terminal.flush();

		// Jump to the oldest line; L0 sits above the pre-open tail, proving the pager surfaces full history.
		terminal.sendInput("g");
		await terminal.flush();
		const pagerViewport = viewportText(terminal);
		assert.ok(pagerViewport.includes("L0"), `pager must reach the oldest line; got:\n${pagerViewport}`);
		assert.ok(pagerViewport.includes("/30"), `status must show the full row count; got:\n${pagerViewport}`);

		// Return to live: the alt screen restores the saved primary screen and scrollback untouched.
		const beforeExit = terminal.raw.length;
		terminal.sendInput("q");
		assert.strictEqual(host.historyOpen, false, "q must close the pager");
		const exitBytes = terminal.raw.slice(beforeExit);
		assert.ok(exitBytes.includes(ALT_EXIT), "must leave the alternate screen on exit");
		assert.ok(exitBytes.includes(AUTOWRAP_ON), "must restore autowrap on exit");
		assert.ok(exitBytes.includes(SHOW_CURSOR), "must restore cursor visibility on exit");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			bufferLines(terminal),
			scrollbackBeforeOpen,
			"the pager must not disturb the primary-screen scrollback",
		);
		host.stop();
	});

	it("is modal while open: keys drive the pager and never leak to the live editor beneath", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(terminal);
		let editorKeys = "";
		const editor: Component = {
			render: () => ["> "],
			invalidate: () => {},
			handleInput: (data: string) => {
				editorKeys += data;
			},
		};
		host.addChild(new Transcript(Array.from({ length: 12 }, (_, i) => `L${i}`)));
		host.addChild(editor);
		host.setFocus(editor);
		host.start();
		await terminal.waitForRender();

		// Before opening, a printable reaches the focused editor.
		terminal.sendInput("a");
		assert.strictEqual(editorKeys, "a", "editor receives input before the pager opens");

		terminal.sendInput(CTRL_R);
		assert.strictEqual(host.historyOpen, true);

		// While open every sequence is consumed by the pager; the editor sees nothing more.
		terminal.sendInput("b");
		terminal.sendInput("g");
		assert.strictEqual(editorKeys, "a", "editor must not receive input while the pager is modal");
		assert.strictEqual(host.historyOpen, true, "navigation keys must not close the pager");

		host.stop();
	});

	it("forwards genuine terminal resizes to the pager so it reflows while open", async () => {
		const terminal = new RecordingTerminal(30, 8);
		const host = new V2TUIHost(terminal);
		// One 48-cell logical line: wraps to 2 rows at width 30, 4 rows at width 12.
		host.addChild(new Transcript(["W".repeat(48)]));
		host.start();
		await terminal.waitForRender();

		terminal.sendInput(CTRL_R);
		await terminal.flush();
		assert.ok(viewportText(terminal).includes("/2"), "status reflects the width-30 wrapped row count");

		// Real resize path: terminal.resize fires the onResize callback wired by the base host.
		terminal.resize(12, 8);
		await terminal.flush();
		assert.strictEqual(host.historyOpen, true, "resize must not close the pager");
		assert.ok(viewportText(terminal).includes("/4"), "status must reflect the reflowed width-12 row count");

		host.stop();
	});

	it("suspends v1 while open and shows commits made during the pager on return-to-live", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(terminal);
		const transcript = new Transcript(Array.from({ length: 10 }, (_, i) => `L${i}`));
		host.addChild(transcript);
		host.start();
		await terminal.waitForRender();

		terminal.sendInput(CTRL_R);
		await terminal.flush();
		assert.strictEqual(host.historyOpen, true);

		// A live commit arrives while the pager owns the screen: v1 must not paint onto the alt screen.
		const rawBeforeCommit = terminal.raw.length;
		transcript.lines = [...transcript.lines, "COMMIT-WHILE-OPEN"];
		host.requestRender();
		assert.strictEqual(
			terminal.raw.length,
			rawBeforeCommit,
			"suspended v1 must write nothing while the pager owns the terminal",
		);
		assert.strictEqual(host.historyOpen, true, "a live commit must not disturb the open pager");

		// Return to live: the forced repaint surfaces the commit made while the pager was open.
		terminal.sendInput("q");
		assert.strictEqual(host.historyOpen, false);
		await terminal.waitForRender();
		assert.ok(
			bufferLines(terminal).includes("COMMIT-WHILE-OPEN"),
			"return-to-live must repaint the commit made while the pager was open",
		);
		host.stop();
	});

	it("closes the pager and restores modes on every exit key and on stop()", async () => {
		for (const exit of [
			{ key: ESC, label: "escape" },
			{ key: CTRL_C, label: "ctrl+c" },
		]) {
			const terminal = new RecordingTerminal(40, 8);
			const host = new V2TUIHost(terminal);
			host.addChild(new Transcript(["L0", "L1", "L2"]));
			host.start();
			await terminal.waitForRender();

			terminal.sendInput(CTRL_R);
			assert.strictEqual(host.historyOpen, true, `${exit.label}: pager must open`);
			const beforeExit = terminal.raw.length;
			terminal.sendInput(exit.key);
			assert.strictEqual(host.historyOpen, false, `${exit.label} must close the pager`);
			const exitBytes = terminal.raw.slice(beforeExit);
			assert.ok(exitBytes.includes(ALT_EXIT), `${exit.label}: must leave the alternate screen`);
			assert.ok(exitBytes.includes(AUTOWRAP_ON), `${exit.label}: must restore autowrap`);
			assert.ok(exitBytes.includes(SHOW_CURSOR), `${exit.label}: must restore cursor visibility`);
			host.stop();
		}

		// stop() while the pager is open restores the primary screen + modes before base teardown.
		const terminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(terminal);
		host.addChild(new Transcript(["L0", "L1", "L2"]));
		host.start();
		await terminal.waitForRender();
		terminal.sendInput(CTRL_R);
		assert.strictEqual(host.historyOpen, true);
		const beforeStop = terminal.raw.length;
		host.stop();
		assert.strictEqual(host.historyOpen, false, "stop() must close an open pager");
		const stopBytes = terminal.raw.slice(beforeStop);
		assert.ok(stopBytes.includes(ALT_EXIT), "stop() must leave the alternate screen");
		assert.ok(stopBytes.includes(AUTOWRAP_ON), "stop() must restore autowrap");
		assert.ok(stopBytes.includes(SHOW_CURSOR), "stop() must restore cursor visibility");
	});

	it("fails safe to a coherent live view when the pager throws after rendering is suspended, without swallowing the error", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(terminal);
		// A child whose render throws only once armed. snapshotHistory() renders the whole tree, so an armed
		// bomb makes the viewer's resize->reflow->source path throw AFTER suspendRendering() (the realistic case).
		const bomb = {
			armed: false,
			render(_width: number): string[] {
				if (this.armed) throw new Error("history-source-boom");
				return [];
			},
			invalidate(): void {},
		};
		host.addChild(new Transcript(Array.from({ length: 10 }, (_, i) => `L${i}`)));
		host.addChild(bomb);
		host.start();
		await terminal.waitForRender();

		terminal.sendInput(CTRL_R);
		assert.strictEqual(host.historyOpen, true, "pager opens while the source is healthy");

		// Arm the source, then drive a genuine resize: reflow re-invokes the source and throws after suspend.
		bomb.armed = true;
		const beforeAbort = terminal.raw.length;
		assert.throws(
			() => terminal.resize(20, 8),
			/history-source-boom/,
			"the originating error must propagate (never swallowed)",
		);

		// Rolled back synchronously: partial viewer torn down and the primary screen restored before the throw.
		assert.strictEqual(host.historyOpen, false, "a throw after suspend must clear the partial viewer state");
		const abortBytes = terminal.raw.slice(beforeAbort);
		assert.ok(abortBytes.includes(ALT_EXIT), "rollback must leave the alternate screen");
		assert.ok(abortBytes.includes(AUTOWRAP_ON), "rollback must restore autowrap");
		assert.ok(abortBytes.includes(SHOW_CURSOR), "rollback must restore cursor visibility");

		// Coherent live rendering resumes: with the source healthy again the scheduled forced repaint paints live.
		bomb.armed = false;
		await terminal.waitForRender();
		assert.ok(bufferLines(terminal).includes("L9"), "rendering must resume so the live tail repaints after rollback");
		host.stop();
	});

	it("is byte-identical to the base TUI on the default path when the pager is never opened (A/B parity)", async () => {
		const lines = Array.from({ length: 12 }, (_, i) => `row-${i}`);
		const baseTerminal = new RecordingTerminal(40, 8);
		const base = new TUI(baseTerminal);
		base.addChild(new Transcript(lines));
		base.start();
		await baseTerminal.waitForRender();

		const hostTerminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(hostTerminal);
		host.addChild(new Transcript(lines));
		host.start();
		await hostTerminal.waitForRender();

		// The host adds only an input hook + inert overrides while the pager is closed: output must match exactly.
		assert.strictEqual(hostTerminal.raw, baseTerminal.raw, "v2 host default path must be byte-identical to base TUI");

		// A resize on the default path must also stay byte-identical (no suspend, no pager involvement).
		baseTerminal.resize(24, 10);
		hostTerminal.resize(24, 10);
		await baseTerminal.waitForRender();
		await hostTerminal.waitForRender();
		assert.strictEqual(hostTerminal.raw, baseTerminal.raw, "default-path resize must be byte-identical to base TUI");
		base.stop();
		host.stop();
	});

	it("opens idempotently and keeps the newest content reachable across a resize (no tail loss)", async () => {
		const terminal = new RecordingTerminal(30, 8);
		const host = new V2TUIHost(terminal);
		// Long lines so they reflow to more rows at a narrower width; TAIL marks the very newest line.
		const rows = [...Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(28)}`), "TAIL"];
		host.addChild(new Transcript(rows));
		host.start();
		await terminal.waitForRender();

		const countAltEnter = () => terminal.raw.split(ALT_ENTER).length - 1;
		terminal.sendInput(CTRL_R);
		await terminal.flush();
		assert.strictEqual(host.historyOpen, true);
		assert.strictEqual(countAltEnter(), 1, "opening must enter the alternate screen exactly once");
		const parseStatus = (): { last: number; total: number } => {
			const m = viewportText(terminal).match(/(\d+)-(\d+)\/(\d+)/);
			assert.ok(m, `status line must show a position; got:\n${viewportText(terminal)}`);
			return { last: Number(m[2]), total: Number(m[3]) };
		};
		// Opens anchored at the tail: the newest row is on screen (last === total).
		const opened = parseStatus();
		assert.strictEqual(opened.last, opened.total, "pager must open anchored at the newest content");

		// A second open is a no-op: no duplicate alt-screen entry, still modal.
		host.openHistory();
		assert.strictEqual(countAltEnter(), 1, "re-opening while open must not re-enter the alternate screen");
		assert.strictEqual(host.historyOpen, true);

		// Reflow at a narrower width, then jump to the bottom: the newest row is still reachable (no tail loss).
		terminal.resize(12, 8);
		await terminal.flush();
		terminal.sendInput("G");
		await terminal.flush();
		const afterResize = parseStatus();
		assert.strictEqual(afterResize.last, afterResize.total, "the newest content must stay reachable after resize");
		assert.ok(afterResize.total > opened.total, "a narrower width must reflow to more wrapped rows");
		assert.ok(viewportText(terminal).includes("TAIL"), "the newest line must be visible at the bottom after resize");

		const countAltExit = () => terminal.raw.split(ALT_EXIT).length - 1;
		terminal.sendInput("q");
		assert.strictEqual(host.historyOpen, false);
		assert.strictEqual(countAltExit(), 1, "closing must leave the alternate screen exactly once");
		host.stop();
	});

	it("suppresses every base render path while the pager owns the screen", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const host = new V2TUIHost(terminal);
		const transcript = new Transcript(Array.from({ length: 10 }, (_, i) => `L${i}`));
		host.addChild(transcript);
		host.start();
		await terminal.waitForRender();

		terminal.sendInput(CTRL_R);
		await terminal.flush();
		assert.strictEqual(host.historyOpen, true);

		// Force-repaint, throttled schedule, and a live commit must all write nothing while suspended — including
		// after the render timer would have fired (waitForRender drains the nextTick + throttle window).
		const rawBefore = terminal.raw.length;
		host.requestRender(true);
		transcript.lines = [...transcript.lines, "SHOULD-NOT-PAINT"];
		host.requestRender();
		host.invalidate();
		host.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.raw.length, rawBefore, "no base render path may write while the pager is suspended");
		assert.ok(
			!viewportText(terminal).includes("SHOULD-NOT-PAINT"),
			"suspended commits must not reach the alt screen",
		);
		host.stop();
	});
});
