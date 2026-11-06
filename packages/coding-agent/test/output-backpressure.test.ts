import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("output spill backpressure", () => {
	it("drains a large write before the complete output file is closed", async () => {
		const output = new OutputAccumulator({ maxBytes: 16, maxLines: 4 });
		try {
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
		} finally {
			await output.closeTempFile();
			const path = output.snapshot().fullOutputPath;
			if (path) await unlink(path).catch(() => {});
		}
	});
});

describe.skipIf(process.platform === "win32")("local shell output backpressure integration", () => {
	it("preserves large simultaneous stdout and stderr streams while the spill file drains", async () => {
		const output = new OutputAccumulator({ maxBytes: 128, maxLines: 8 });
		const shell = createLocalBashOperations();
		const command =
			'node -e "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 65));process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 66))"';
		try {
			const result = await shell.exec(command, tmpdir(), {
				onData: (chunk) => {
					output.append(chunk);
					return output.waitForDrain();
				},
			});
			expect(result.exitCode).toBe(0);
			output.finish();
			const snapshot = output.snapshot({ persistIfTruncated: true });
			await output.closeTempFile();
			expect(snapshot.truncation.truncated).toBe(true);
			expect(snapshot.fullOutputPath).toBeDefined();
			const metadata = await stat(snapshot.fullOutputPath!);
			expect(metadata.size).toBe(4 * 1024 * 1024);
		} finally {
			await output.closeTempFile();
			const path = output.snapshot().fullOutputPath;
			if (path) await unlink(path).catch(() => {});
		}
	});
});
