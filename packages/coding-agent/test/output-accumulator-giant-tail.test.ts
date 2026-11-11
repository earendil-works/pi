import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("OutputAccumulator giant trailing line", () => {
	const accumulators: OutputAccumulator[] = [];

	afterEach(async () => {
		await Promise.all(accumulators.splice(0).map((accumulator) => accumulator.closeTempFile()));
	});

	function feed(chunks: string[]): OutputAccumulator {
		const accumulator = new OutputAccumulator({ tempFilePrefix: "pi-test-accumulator" });
		accumulators.push(accumulator);
		for (const chunk of chunks) {
			accumulator.append(Buffer.from(chunk, "utf-8"));
		}
		accumulator.finish();
		return accumulator;
	}

	// A short first line followed by one line past the rolling limit: the retained tail starts
	// mid-line and holds nothing but that line's end plus its newline.
	it("keeps output when the clipped tail is one partial line", () => {
		const snapshot = feed(["first line\n", `${"y".repeat(219_000)}\n`]).snapshot();
		const { truncation } = snapshot;

		expect(snapshot.content.length).toBeGreaterThan(0);
		expect(truncation.outputLines).toBeGreaterThan(0);
		expect(truncation.lastLinePartial).toBe(true);
		expect(truncation.totalLines - truncation.outputLines + 1).toBeLessThanOrEqual(truncation.totalLines);
	});

	it("still drops the incomplete first line when more output follows it", () => {
		const snapshot = feed(["x".repeat(219_000), "\ntail line\n"]).snapshot();

		expect(snapshot.content).toBe("tail line\n");
		expect(snapshot.truncation.lastLinePartial).toBe(false);
	});
});
