import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, isFocusable, type TUI } from "../src/tui.ts";
import { cellsToAnsi, styledLineToAnsi } from "../src/v2/ansi.ts";
import { CellBuffer } from "../src/v2/cell-buffer.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import { V2TUIHost } from "../src/v2/host.ts";
import { LegacyBlockRendererAdapter, LegacyStripAdapter } from "../src/v2/legacy.ts";
import { LedgerBandRenderer } from "../src/v2/renderer.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class ManualClock implements FrameClock {
	private seq = 0;
	now(): number {
		return 0;
	}
	setTimeout(_callback: () => void, _delayMs: number): unknown {
		return ++this.seq;
	}
	clearTimeout(_handle: unknown): void {}
}

class FakeComponent implements Component {
	lines: string[];
	invalidated = 0;
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {
		this.invalidated++;
	}
}

/** Non-empty content once SGR sequences are removed. */
function withoutSgr(wire: string): string {
	return wire.replace(/\x1b\[[0-9;]*m/g, "");
}

const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/;

describe("LegacyStripAdapter", () => {
	it("renders a v1 component into the band and caches until invalidated", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, clock });
		const component = new FakeComponent(["\x1b[1mbold\x1b[0m", "plain"]);
		const adapter = new LegacyStripAdapter(component);
		renderer.addStrip({ id: "legacy", strip: adapter, policy: { priority: 0 } });

		renderer.flush();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 2), ["bold", "plain"]);

		// Content change through the adapter re-renders and relays out the band.
		component.lines = ["one", "two", "three"];
		adapter.invalidate();
		assert.strictEqual(component.invalidated, 1);
		renderer.flush();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 3), ["one", "two", "three"]);
		renderer.stop();
	});

	it("clips an over-wide legacy line to the region instead of throwing", async () => {
		const terminal = new VirtualTerminal(8, 4);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, clock });
		const adapter = new LegacyStripAdapter(new FakeComponent(["0123456789ABCDEF"]));
		renderer.addStrip({ id: "wide", strip: adapter, policy: { priority: 0 } });
		renderer.flush();
		await terminal.flush();
		assert.strictEqual(terminal.getViewport()[0], "01234567");
		renderer.stop();
	});

	it("keeps legacy strip content control-free on the wire via cellsToAnsi (plan §3)", () => {
		// Bare C0/DEL/C1 bytes are not ESC-introduced, so the ANSI parser passes them into span text;
		// painting them lands zero-width control clusters in the cell buffer. The band's own serializer
		// (cellsToAnsi) is the §3 choke point that must strip them like any other content.
		const buffer = new CellBuffer(8, 1);
		const adapter = new LegacyStripAdapter(new FakeComponent(["a\x07b\x00c\x7fd"]));
		adapter.paint(buffer.region(0, 0, buffer.width, 1));
		const cells = Array.from({ length: buffer.width }, (_, column) => buffer.get(0, column));
		const visible = withoutSgr(cellsToAnsi(cells, buffer.styles, buffer.links));
		assert.doesNotMatch(visible, CONTROL_BYTES, "cellsToAnsi strips control clusters from legacy content");
		assert.ok(visible.includes("abcd"), "printable legacy content survives sanitization");
	});
});

describe("LegacyBlockRendererAdapter", () => {
	it("parses a v1 ANSI block render into structured styled lines", () => {
		const adapter = new LegacyBlockRendererAdapter<{ label: string }, undefined>(
			(model) => `\x1b[32m${model.label}\x1b[0m\nsecond\n`,
		);
		const lines = adapter.render({ label: "first" }, 40, undefined);
		assert.strictEqual(lines.length, 2);
		assert.strictEqual(lines[0]!.map((span) => span.text).join(""), "first");
		assert.deepStrictEqual(lines[0]![0]!.style.foreground, { kind: "indexed", index: 2 });
		assert.strictEqual(lines[1]!.map((span) => span.text).join(""), "second");
	});

	it("commits through the ledger like a native renderer", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, clock });
		const blockRenderer = new LegacyBlockRendererAdapter<string, undefined>((model) => model);
		renderer.ledger.addBlock({ id: "b", model: "alpha\nbeta", renderer: blockRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 2), ["alpha", "beta"]);
		renderer.stop();
	});

	it("strips control bytes that survive the ANSI parse when serialized (plan §3)", () => {
		const adapter = new LegacyBlockRendererAdapter<string, undefined>((model) => model);
		const [line] = adapter.render("a\x07b\x00c\x7fd\x9be", 40, undefined);
		assert.ok(line, "one styled line");
		// Precondition: a control byte really survives the ANSI parse into span text.
		assert.match(line.map((span) => span.text).join(""), CONTROL_BYTES);
		const visible = withoutSgr(styledLineToAnsi(line));
		assert.doesNotMatch(visible, CONTROL_BYTES, "styledLineToAnsi strips surviving control bytes");
		assert.strictEqual(visible, "abcde", "printable legacy content survives sanitization");
	});
});

describe("V2TUIHost as the concrete TUI for extension factory callbacks (plan §7)", () => {
	it("behaves as a real TUI — inherited children/focus/overlay/input machinery, not a facade", () => {
		const host = new V2TUIHost(new VirtualTerminal(30, 8));

		// Extension factory callbacks are typed `(tui: TUI, ...) => ...`; a V2TUIHost must satisfy that
		// parameter AND expose working TUI behavior, so a narrow structural facade is insufficient.
		const factory = (tui: TUI): string[] => {
			const child: Component = { render: () => ["from-extension"], invalidate() {} };
			tui.addChild(child);
			return tui.render(tui.terminal.columns);
		};
		assert.ok(factory(host).includes("from-extension"), "inherited Container render composes extension children");

		// Real focus machinery: a Focusable child receives focus state.
		const focusable = { focused: false, render: () => [], invalidate() {} };
		host.setFocus(focusable);
		assert.strictEqual(focusable.focused, true, "setFocus drives the Focusable contract");
		assert.ok(isFocusable(focusable));

		// Real overlay machinery: showOverlay returns a working handle and toggles overlay state.
		const overlay: Component = { render: () => ["overlay"], invalidate() {} };
		const handle = host.showOverlay(overlay);
		assert.strictEqual(host.hasOverlay(), true, "overlay registered on the inherited stack");
		handle.hide();
		assert.strictEqual(host.hasOverlay(), false, "the overlay handle really removes it");

		// Real input-listener machinery: registration returns a working unsubscribe.
		const off = host.addInputListener(() => undefined);
		assert.strictEqual(typeof off, "function", "addInputListener returns an unsubscribe");
		off();

		host.stop();
	});
});
