// Tests of frames for the terminal (slice 11 §4; fix round 1, Fable L9): a write over the launcher's 64 KiB arrives
// as frames each under it, cut only between escape sequences and surrogate pairs, the filter keeping every one whole.

import { describe, expect, it } from "vitest";
import { filterOutput, MAX_FRAME } from "../../src/node/tui/filter.ts";
import { FRAME_UNITS, splitFrames } from "../../src/tui/frames.ts";

describe("splitting frames", () => {
	it("keeps a small write whole", () => {
		expect(splitFrames("hello")).toEqual(["hello"]);
	});

	it("cuts a large true-colour paint between sequences, each frame under 64 KiB and passing the filter whole", () => {
		let paint = "";
		for (let cell = 0; cell < 20_000; cell++)
			paint += `\x1b[38;2;${cell % 256};12;200m${cell % 7 === 0 ? "😀" : "é"}`;
		const frames = splitFrames(paint);
		expect(frames.length).toBeGreaterThan(1);
		expect(frames.join("")).toBe(paint);
		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(FRAME_UNITS);
			expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX_FRAME);
			expect(filterOutput(frame)).toBe(frame);
		}
	});
});
