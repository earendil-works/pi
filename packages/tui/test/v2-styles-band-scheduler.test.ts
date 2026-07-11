import assert from "node:assert";
import { describe, it } from "node:test";
import { BandLayout, type Strip } from "../src/v2/band.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import { FrameScheduler } from "../src/v2/frame-scheduler.ts";
import { Signal } from "../src/v2/signal.ts";
import { DEFAULT_TEXT_STYLE, StyleTable, type TextStyle } from "../src/v2/styles.ts";

class TestStrip implements Strip {
	readonly onDirty = new Signal<void>();
	readonly onLayoutDirty = new Signal<void>();
	private readonly height: number;

	constructor(height: number) {
		this.height = height;
	}

	measure(_width: number): number {
		return this.height;
	}

	paint(): void {}
}

class ManualClock implements FrameClock {
	private time = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { due: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.timers.set(id, { due: this.time + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") this.timers.delete(handle);
	}

	tick(milliseconds: number): void {
		this.time += milliseconds;
		while (true) {
			const ready = [...this.timers.entries()]
				.filter(([, timer]) => timer.due <= this.time)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
			if (ready.length === 0) return;
			const [id, timer] = ready[0]!;
			this.timers.delete(id);
			timer.callback();
		}
	}
}

function style(overrides: Partial<TextStyle>): TextStyle {
	return { ...DEFAULT_TEXT_STYLE, ...overrides };
}

describe("StyleTable", () => {
	it("reserves id zero and interns equivalent styles", () => {
		const table = new StyleTable();
		assert.strictEqual(table.intern(DEFAULT_TEXT_STYLE), 0);
		const first = table.intern(style({ bold: true }));
		const second = table.intern(style({ bold: true }));
		assert.strictEqual(first, second);
		assert.strictEqual(table.size, 2);
	});

	it("normalizes color channels before interning", () => {
		const table = new StyleTable();
		const first = table.intern(style({ foreground: { kind: "rgb", red: -10, green: 999, blue: 1.8 } }));
		const second = table.intern(style({ foreground: { kind: "rgb", red: 0, green: 255, blue: 1 } }));
		assert.strictEqual(first, second);
		assert.deepStrictEqual(table.get(first).foreground, { kind: "rgb", red: 0, green: 255, blue: 1 });
	});
});

describe("BandLayout", () => {
	it("assigns one owner for top-down strip geometry", () => {
		const layout = new BandLayout().layout(
			[
				{ id: "tail", strip: new TestStrip(3), policy: { priority: 0 } },
				{ id: "editor", strip: new TestStrip(4), policy: { priority: 10, minHeight: 2 } },
				{ id: "footer", strip: new TestStrip(1), policy: { priority: 5 } },
			],
			80,
			6,
		);
		assert.strictEqual(layout.height, 6);
		assert.deepStrictEqual(
			layout.strips.map(({ slot, y, height }) => ({ id: slot.id, y, height })),
			[
				{ id: "tail", y: 0, height: 1 },
				{ id: "editor", y: 1, height: 4 },
				{ id: "footer", y: 5, height: 1 },
			],
		);
	});

	it("clips impossible minimums without exceeding the viewport", () => {
		const layout = new BandLayout().layout(
			[
				{ id: "low", strip: new TestStrip(4), policy: { priority: 0, minHeight: 4 } },
				{ id: "high", strip: new TestStrip(4), policy: { priority: 10, minHeight: 4 } },
			],
			20,
			3,
		);
		assert.strictEqual(layout.height, 3);
		assert.deepStrictEqual(
			layout.strips.map((entry) => entry.height),
			[0, 3],
		);
	});
});

describe("FrameScheduler", () => {
	it("coalesces requests and enforces the frame interval", () => {
		const clock = new ManualClock();
		const frames: Array<{ now: number; forced: boolean }> = [];
		const scheduler = new FrameScheduler((frame) => frames.push(frame), clock, 16);
		scheduler.requestFrame();
		scheduler.requestFrame();
		clock.tick(0);
		assert.deepStrictEqual(frames, [{ now: 0, forced: false }]);
		scheduler.requestFrame();
		clock.tick(15);
		assert.strictEqual(frames.length, 1);
		clock.tick(1);
		assert.deepStrictEqual(frames[1], { now: 16, forced: false });
	});

	it("lets a force request preempt the interval", () => {
		const clock = new ManualClock();
		const frames: Array<{ now: number; forced: boolean }> = [];
		const scheduler = new FrameScheduler((frame) => frames.push(frame), clock, 16);
		scheduler.requestFrame();
		clock.tick(0);
		clock.tick(1);
		scheduler.requestFrame();
		scheduler.requestFrame(true);
		clock.tick(0);
		assert.deepStrictEqual(frames[1], { now: 1, forced: true });
	});

	it("schedules a request made during a frame", () => {
		const clock = new ManualClock();
		let frames = 0;
		let scheduler: FrameScheduler;
		scheduler = new FrameScheduler(
			() => {
				frames++;
				if (frames === 1) scheduler.requestFrame();
			},
			clock,
			16,
		);
		scheduler.requestFrame();
		clock.tick(0);
		assert.strictEqual(frames, 1);
		clock.tick(16);
		assert.strictEqual(frames, 2);
	});
});
