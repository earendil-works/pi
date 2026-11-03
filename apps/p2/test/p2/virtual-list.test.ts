// The transcript's virtual list model (src/web/virtual-list.ts) and its scroll gesture tracking
// (src/web/scroll-gesture.ts): where rows are, which ones to render, and when corrections may be written.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RowEstimator } from "../../src/web/row-estimate.ts";
import { ScrollGesture, SETTLE_MS } from "../../src/web/scroll-gesture.ts";
import { keptSizes, RowLayout } from "../../src/web/virtual-list.ts";

const keys = (count: number, prefix = "row") => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("row layout", () => {
	it("places estimated rows and replaces an estimate with the measured height", () => {
		const layout = new RowLayout();
		layout.setRows(keys(5), () => 100);
		assert.equal(layout.total, 500);
		assert.equal(layout.offsetOf(3), 300);
		assert.equal(layout.measure("row1", 40), true);
		assert.equal(layout.measure("row1", 40), false, "an unchanged height is no change");
		assert.equal(layout.offsetOf(3), 240);
		assert.equal(layout.total, 440);
		assert.equal(layout.measured("row1"), true);
		assert.equal(layout.measured("row2"), false);
	});

	it("finds the rows overlapping a span", () => {
		const layout = new RowLayout();
		layout.setRows(keys(10), () => 100);
		assert.deepEqual(layout.range(250, 450), { start: 2, end: 4 });
		// A row starting exactly at the span's end is outside it; one ending at its start is too.
		assert.deepEqual(layout.range(300, 500), { start: 3, end: 4 });
		// Beyond the ends: the first or last row.
		assert.deepEqual(layout.range(-500, -100), { start: 0, end: 0 });
		assert.deepEqual(layout.range(5000, 6000), { start: 9, end: 9 });
		assert.deepEqual(layout.range(-100, 5000), { start: 0, end: 9 });
		assert.equal(new RowLayout().range(0, 100), undefined);
	});

	it("keeps measured heights by key, so rows added before others keep theirs", () => {
		const sizes = new Map<string, number>();
		const layout = new RowLayout(sizes);
		layout.setRows(["a", "b"], () => 100);
		layout.measure("a", 30);
		layout.measure("b", 70);
		// An older page arrives before them.
		layout.setRows(["x", "y", "a", "b"], () => 50);
		assert.equal(layout.indexOf("a"), 2);
		assert.equal(layout.offsetOf(2), 100);
		assert.equal(layout.total, 200);
		// A layout for the same list later starts from the measured heights.
		const again = new RowLayout(sizes);
		again.setRows(["a", "b"], () => 1);
		assert.equal(again.total, 100);
	});

	it("keeps the measured heights of a few recent lists", () => {
		const first = keptSizes("first");
		first.set("a", 10);
		assert.equal(keptSizes("first"), first);
		for (let index = 0; index < 8; index++) keptSizes(`other${index}`);
		assert.notEqual(keptSizes("first"), first, "the least recently used list is dropped");
	});
});

describe("scroll gesture", () => {
	it("holds writes while a finger is down and until its momentum settles", async () => {
		let settled = 0;
		const gesture = new ScrollGesture(() => settled++);
		assert.equal(gesture.active, false);
		gesture.press();
		assert.equal(gesture.active, true);
		await wait(SETTLE_MS + 30);
		assert.equal(gesture.active, true, "a resting finger keeps the gesture");
		gesture.lift();
		// Momentum: scroll events keep the tail open.
		for (let step = 0; step < 4; step++) {
			await wait(SETTLE_MS / 2);
			gesture.scrolled();
			assert.equal(gesture.active, true);
		}
		assert.equal(settled, 0);
		await wait(SETTLE_MS + 30);
		assert.equal(gesture.active, false);
		assert.equal(settled, 1);
	});

	it("keeps a slow fling open while the area still moves, and ignores scrolls nobody started", async () => {
		let settled = 0;
		let moving = true;
		const gesture = new ScrollGesture(
			() => settled++,
			() => moving,
		);
		// A scroll event without input before it (our own write) opens nothing.
		gesture.scrolled();
		assert.equal(gesture.active, false);
		gesture.wheel();
		await wait(SETTLE_MS + 30);
		assert.equal(gesture.active, true, "still moving between scroll events");
		moving = false;
		await wait(SETTLE_MS + 30);
		assert.equal(gesture.active, false);
		assert.equal(settled, 1);
		gesture.dispose();
	});
});

describe("row estimates", () => {
	type Row = { kind: string; text: number; image?: number };
	const estimator = () =>
		new RowEstimator<Row>((row) => ({ kind: row.kind, text: row.text, fixed: row.image ?? 0 }), 120);

	it("starts from the fallback, then learns per kind how height grows with text", () => {
		const rows = estimator();
		assert.equal(rows.estimate({ kind: "answer", text: 100 }, 400), 120);
		// Measured answers: 40px plus 1px per 4 characters at this width.
		for (const text of [0, 400, 800, 1600]) rows.measured({ kind: "answer", text }, 400, 40 + text / 4);
		assert.equal(Math.round(rows.estimate({ kind: "answer", text: 1200 }, 400)), 340);
		// Another kind falls back to what all rows taught; once measured, it has its own.
		assert.ok(rows.estimate({ kind: "tool", text: 0 }, 400) > 0);
		for (let index = 0; index < 3; index++) rows.measured({ kind: "tool", text: 0 }, 400, 60);
		assert.equal(rows.estimate({ kind: "tool", text: 0 }, 400), 60);
	});

	it("adds exactly known heights outside the fit, and keeps a row's first estimate", () => {
		const rows = estimator();
		for (let index = 0; index < 3; index++) rows.measured({ kind: "message", text: 10, image: 200 }, 400, 280);
		assert.equal(rows.estimate({ kind: "message", text: 10, image: 300 }, 400), 380);
		const row = { kind: "message", text: 10 };
		const first = rows.estimate(row, 400);
		rows.measured({ kind: "message", text: 10 }, 400, 500);
		assert.equal(rows.estimate(row, 400), first, "learning more does not move a row already estimated");
	});
});
