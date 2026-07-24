import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, Container, TUI } from "../src/index.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function waitForRender(): Promise<void> {
	return new Promise((resolve) => {
		process.nextTick(() => {
			setTimeout(resolve, 30);
		});
	});
}

/**
 * Regression tests for the crash:
 *   "Rendered line N exceeds terminal width (24 > 19)."
 *
 * Root cause: the memoized component tree (Container render cache) could hold
 * lines wrapped to a previous, wider terminal after a shrink resize. Those
 * stale-width lines leaked into the diff path and overflowed the width guard,
 * which used to throw and kill the whole session.
 *
 * Two independent guarantees are covered:
 *   A) On resize, the tree is invalidated so every component recomputes at the
 *      current width (correctness — no stale-width lines).
 *   B) If a broken/misbehaving component still returns an over-wide line, the
 *      diff-path guard truncates it instead of crashing (resilience).
 */
describe("Resize width safety", () => {
	// A leaf that caches its rendered lines by content only, ignoring width,
	// until it is explicitly invalidated. Models a real width-unaware cache.
	class InvalidateAwareLeaf implements Component {
		private cache?: string[];
		render(width: number): string[] {
			if (!this.cache) {
				this.cache = [`${"x".repeat(width)}`, `${"y".repeat(width)}`];
			}
			return this.cache;
		}
		invalidate(): void {
			this.cache = undefined;
		}
	}

	// A leaf that ALWAYS returns lines of a fixed (wide) width and ignores
	// invalidate entirely. Models a genuinely broken component: only the guard
	// net can save the session here. Returns a fresh array each call so the
	// diff path treats it as changed and reaches the width guard.
	class BrokenWideLeaf implements Component {
		private readonly fixedWidth: number;
		private frame = 0;
		constructor(fixedWidth: number) {
			this.fixedWidth = fixedWidth;
		}
		render(_width: number): string[] {
			// Changes every frame so the diff path always treats the line as
			// modified and reaches the width guard, but stays over-wide.
			this.frame += 1;
			const marker = String(this.frame % 10);
			return [`${marker.repeat(this.fixedWidth)}`];
		}
		invalidate(): void {
			// intentionally does nothing
		}
	}

	it("A) shrink resize recomputes the tree at the new width (no stale-width lines)", async () => {
		const terminal = new VirtualTerminal(60, 24);
		const ui = new TUI(terminal);
		const container = new Container();
		container.addChild(new InvalidateAwareLeaf());
		ui.addChild(container);

		// First render at width 60 — leaf caches 60-wide lines.
		ui.requestRender();
		await waitForRender();

		// Shrink the terminal, then render again.
		terminal.resize(20, 24);
		ui.requestRender();
		await waitForRender();

		// After the resize render, the whole tree must reflect width 20.
		const lines = ui.render(20);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= 20,
				`line exceeds width after resize: ${visibleWidth(line)} > 20 (${JSON.stringify(line)})`,
			);
		}
	});

	it("B) an over-wide line from a broken component is truncated, not thrown", async () => {
		const terminal = new VirtualTerminal(60, 24);
		const ui = new TUI(terminal);
		const container = new Container();
		container.addChild(new BrokenWideLeaf(60));
		ui.addChild(container);

		const doRender = (): void => (ui as unknown as { doRender(): void }).doRender();

		// Prime a render at width 60 (60-wide line fits exactly).
		doRender();

		// Shrink to 20: first render takes the width-change full-repaint path.
		terminal.resize(20, 24);
		doRender();

		// Second render at the same width hits the differential path + width guard.
		// Before the fix this threw and killed the session; now it must degrade
		// gracefully by truncating.
		assert.doesNotThrow(() => doRender(), "over-wide line must be truncated, not thrown");
		assert.doesNotThrow(() => doRender());
	});
});
