import assert from "node:assert";
import { describe, it } from "node:test";
import { Loader } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";

describe("Loader", () => {
	it("requests stream-throttled renders (does not use requestRender())", () => {
		const calls: string[] = [];

		const ui = {
			requestRender: () => {
				calls.push("requestRender");
			},
			requestRenderWithReason: (reason: string) => {
				calls.push(reason);
			},
		} as unknown as TUI;

		const loader = new Loader(
			ui,
			(s) => s,
			(s) => s,
			"Loading...",
		);

		// Ensure we don't leak the interval into the test runner.
		loader.stop();

		assert.ok(calls.includes("stream"), `expected calls to include "stream", got: ${calls.join(", ")}`);
		assert.ok(
			!calls.includes("requestRender"),
			`expected Loader not to call requestRender(), got: ${calls.join(", ")}`,
		);
	});
});
