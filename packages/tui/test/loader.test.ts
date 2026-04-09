import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Loader } from "../src/components/loader.js";

describe("Loader", () => {
	test("setFrames replaces spinner frames and interval", () => {
		const events: Array<{ type: string; ms?: number }> = [];
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;

		globalThis.setInterval = ((fn: (...args: never[]) => void, ms?: number) => {
			events.push({ type: "setInterval", ms: typeof ms === "number" ? ms : undefined });
			return { fn, ms } as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval;
		globalThis.clearInterval = ((_id?: ReturnType<typeof setInterval>) => {
			events.push({ type: "clearInterval" });
		}) as typeof clearInterval;

		try {
			const ui = { requestRender() {} } as any;
			const loader = new Loader(
				ui,
				(s: string) => s,
				(s: string) => s,
				"Working...",
			);
			(loader as any).intervalId = { stale: true };
			loader.setFrames(["a", "b", "c"], 120);

			assert.deepEqual((loader as any).frames, ["a", "b", "c"]);
			assert.equal((loader as any).currentFrame, 0);
			assert.equal(events.at(-2)?.type, "clearInterval");
			assert.equal(events.at(-1)?.type, "setInterval");
			assert.equal(events.at(-1)?.ms, 120);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	test("setFrames with undefined restores default frames and interval", () => {
		const ui = { requestRender() {} } as any;
		const loader = new Loader(
			ui,
			(s: string) => s,
			(s: string) => s,
			"Working...",
		);
		loader.setFrames(["x"], 120);
		loader.setFrames(undefined);

		assert.deepEqual((loader as any).frames, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
		assert.equal((loader as any).intervalMs, 80);
	});
});
