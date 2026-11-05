import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("OutputAccumulator last line size (#10015)", () => {
	const tempFiles: string[] = [];

	afterEach(async () => {
		await Promise.all(tempFiles.splice(0).map((path) => rm(path, { force: true })));
	});

	async function sizeOf(chunks: string[]): Promise<{ lastLineBytes: number; lastLinePartial: boolean }> {
		const output = new OutputAccumulator({ maxBytes: 1024 });
		for (const chunk of chunks) output.append(Buffer.from(chunk));
		output.finish();
		const snapshot = output.snapshot();
		await output.closeTempFile();
		if (snapshot.fullOutputPath) tempFiles.push(snapshot.fullOutputPath);
		return { lastLineBytes: output.getLastLineBytes(), lastLinePartial: snapshot.truncation.lastLinePartial };
	}

	// #10015: a trailing newline reset the live line counter, so the notice reported the line as 0B.
	it("reports the size of an oversized last line that ends with a newline", async () => {
		expect(await sizeOf([`${"a".repeat(2000)}\n`])).toEqual({ lastLineBytes: 2000, lastLinePartial: true });
	});

	it("reports the size of an oversized last line that is still open", async () => {
		expect(await sizeOf(["a".repeat(2000)])).toEqual({ lastLineBytes: 2000, lastLinePartial: true });
	});

	it("sums a line split across chunks", async () => {
		expect(await sizeOf(["x\n", "a".repeat(1500), `${"a".repeat(500)}\n`])).toEqual({
			lastLineBytes: 2000,
			lastLinePartial: true,
		});
	});

	it("measures only the last line when a chunk holds several", async () => {
		expect(await sizeOf([`short\n${"a".repeat(2000)}\n`])).toEqual({ lastLineBytes: 2000, lastLinePartial: true });
	});
});
