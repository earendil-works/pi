import assert from "node:assert";
import { describe, it } from "node:test";
import { Viewport } from "../src/components/viewport.ts";
import type { Component } from "../src/tui.ts";

class TestComponent implements Component {
	lines: string[];
	mouseRows: number[] = [];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	handleMouse(event: { y: number }): boolean {
		this.mouseRows.push(event.y);
		return true;
	}
	invalidate(): void {}
}

const wheel = (direction: "up" | "down") => ({
	type: "wheel" as const,
	direction,
	x: 0,
	y: 0,
	shift: false,
	alt: false,
	ctrl: false,
});

describe("Viewport", () => {
	it("keeps the fixed region at the bottom and shows the latest history", () => {
		const content = new TestComponent(Array.from({ length: 8 }, (_, index) => `history ${index}`));
		const fixed = new TestComponent(["input", "footer"]);
		const viewport = new Viewport({ content, fixed, getHeight: () => 6, scrollStep: 2 });

		assert.deepStrictEqual(viewport.render(20), [
			"history 4",
			"history 5",
			"history 6",
			"history 7",
			"input",
			"footer",
		]);
	});

	it("scrolls only history while the fixed region stays visible", () => {
		const content = new TestComponent(Array.from({ length: 8 }, (_, index) => `history ${index}`));
		const fixed = new TestComponent(["input", "footer"]);
		const viewport = new Viewport({ content, fixed, getHeight: () => 6, scrollStep: 2 });

		viewport.render(20);
		assert.strictEqual(viewport.handleMouse(wheel("up")), true);
		assert.deepStrictEqual(viewport.render(20), [
			"history 2",
			"history 3",
			"history 4",
			"history 5",
			"input",
			"footer",
		]);
	});

	it("preserves the reviewed lines when new history arrives", () => {
		const content = new TestComponent(Array.from({ length: 8 }, (_, index) => `history ${index}`));
		const fixed = new TestComponent(["input", "footer"]);
		const viewport = new Viewport({ content, fixed, getHeight: () => 6, scrollStep: 2 });

		viewport.render(20);
		viewport.handleMouse(wheel("up"));
		viewport.render(20);
		content.lines.push("history 8", "history 9");

		assert.deepStrictEqual(viewport.render(20).slice(0, 4), ["history 2", "history 3", "history 4", "history 5"]);
	});

	it("resumes following the latest history after scrollToBottom", () => {
		const content = new TestComponent(Array.from({ length: 8 }, (_, index) => `history ${index}`));
		const viewport = new Viewport({
			content,
			fixed: new TestComponent(["input", "footer"]),
			getHeight: () => 6,
			scrollStep: 2,
		});

		viewport.render(20);
		viewport.handleMouse(wheel("up"));
		viewport.scrollToBottom();
		assert.deepStrictEqual(viewport.render(20).slice(0, 4), ["history 4", "history 5", "history 6", "history 7"]);
	});

	it("routes fixed-region coordinates after clipping an oversized fixed region", () => {
		const fixed = new TestComponent(["fixed 0", "fixed 1", "fixed 2", "fixed 3", "fixed 4"]);
		const viewport = new Viewport({
			content: new TestComponent(["history"]),
			fixed,
			getHeight: () => 3,
		});

		assert.deepStrictEqual(viewport.render(20), ["fixed 2", "fixed 3", "fixed 4"]);
		viewport.handleMouse({
			type: "press",
			button: "left",
			x: 0,
			y: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.deepStrictEqual(fixed.mouseRows, [3]);
	});

	it("pads short history so the fixed region remains at the bottom", () => {
		const viewport = new Viewport({
			content: new TestComponent(["history 0"]),
			fixed: new TestComponent(["input", "footer"]),
			getHeight: () => 6,
		});

		assert.deepStrictEqual(viewport.render(20), ["history 0", "", "", "", "input", "footer"]);
	});
});
