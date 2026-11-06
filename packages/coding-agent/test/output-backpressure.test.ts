import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("output spill backpressure", () => {
	it("drains a large write before the complete output file is closed", async () => {
		const output = new OutputAccumulator({ maxBytes: 16, maxLines: 4 });
		const data = Buffer.alloc(2 * 1024 * 1024, "a");
		output.append(data);
		const drain = output.waitForDrain();
		expect(drain).toBeDefined();
		await drain;
		output.finish();
		await output.closeTempFile();
		const full = await output.readFullOutput(256);
		expect(full.truncated).toBe(true);
		expect(full.content).toContain("bytes omitted");
		expect(full.content.startsWith("a")).toBe(true);
		expect(full.content.endsWith("a".repeat(128))).toBe(true);
	});
});
