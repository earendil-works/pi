import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { bashExecutionToText } from "../src/core/messages.ts";

describe("user bash output truncation (#10164)", () => {
	const tempFiles: string[] = [];

	afterEach(async () => {
		await Promise.all(tempFiles.splice(0).map((path) => rm(path, { force: true })));
	});

	// #10164: the retained tail can fit even though earlier output was discarded.
	it.each([false, true])("reports discarded chunks when cancelled=%s", async (cancelled) => {
		const first = "error: missing build dependency\n".padEnd(64 * 1024, "x");
		const last = "remaining build output\n".padEnd(44 * 1024, "y");
		const controller = new AbortController();
		const result = await executeBashWithOperations(
			"cat build.log",
			process.cwd(),
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(first));
					onData(Buffer.from(last));
					if (cancelled) {
						controller.abort();
						throw new Error("aborted");
					}
					return { exitCode: 0 };
				},
			},
			{ signal: controller.signal },
		);
		if (result.fullOutputPath) tempFiles.push(result.fullOutputPath);
		// The executor closes its file stream without awaiting its finish event.
		await vi.waitFor(async () => {
			expect(await readFile(result.fullOutputPath!, "utf-8")).toBe(first + last);
		});

		expect(result.cancelled).toBe(cancelled);
		expect(result.output).toBe(last);
		expect(result.truncated).toBe(true);
		expect(
			bashExecutionToText({ role: "bashExecution", command: "cat build.log", timestamp: 0, ...result }),
		).toContain(`[Output truncated. Full output: ${result.fullOutputPath}]`);
	});

	it("does not mark short output as truncated", async () => {
		const result = await executeBashWithOperations("echo done", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("done\n"));
				return { exitCode: 0 };
			},
		});
		expect(result.output).toBe("done\n");
		expect(result.truncated).toBe(false);
		expect(result.fullOutputPath).toBeUndefined();
	});
});
