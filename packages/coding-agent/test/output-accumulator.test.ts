import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("OutputAccumulator", () => {
	it("persists full output to a temp file when truncated", async () => {
		const output = new OutputAccumulator({ maxBytes: 16, maxLines: 1000 });
		const text = `${"x".repeat(64)}\n`;
		output.append(Buffer.from(text, "utf-8"));
		output.finish();

		const snapshot = output.snapshot({ persistIfTruncated: true });
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.fullOutputPath).toBeDefined();

		await output.closeTempFile();
		const persisted = await readFile(snapshot.fullOutputPath!, "utf-8");
		expect(persisted).toBe(text);
		await rm(snapshot.fullOutputPath!, { force: true });
	});

	it("degrades gracefully when the temp file cannot be opened", async () => {
		// The prefix contains a directory that does not exist below tmpdir, so
		// open() fails with ENOENT. Without an error listener on the stream this
		// crashes the process with an uncaught 'error' event.
		const output = new OutputAccumulator({
			maxBytes: 16,
			maxLines: 1000,
			tempFilePrefix: "pi-no-such-dir/output",
		});
		output.append(Buffer.from("x".repeat(64), "utf-8"));
		output.finish();

		// The open failure is reported asynchronously.
		await new Promise((resolve) => setTimeout(resolve, 100));

		const snapshot = output.snapshot({ persistIfTruncated: true });
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("x");
		await output.closeTempFile();
	});
});
