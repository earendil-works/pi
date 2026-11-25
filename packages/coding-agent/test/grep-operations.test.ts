import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import type { GrepOperations } from "../src/index.ts";

const expectedContent = [{ type: "text", text: "file.txt-1- before\nfile.txt:2: needle\nfile.txt-3- after" }];

describe("GrepOperations", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-grep-operations-"));
	writeFileSync(join(cwd, "file.txt"), "before\nneedle\nafter\n");
	afterAll(() => rmSync(cwd, { recursive: true, force: true }));

	// #9276: restoring the public hook must not reintroduce whole-file reads for context.
	it.each([
		{ name: "synchronous", readFile: (_absolutePath: string) => "custom context" },
		{ name: "asynchronous", readFile: async (_absolutePath: string) => "custom context" },
	])("accepts a deprecated $name readFile hook without calling it", async ({ readFile }) => {
		const legacyReadFile = vi.fn(readFile);
		const operations: GrepOperations = { isDirectory: () => true, readFile: legacyReadFile };
		const tool = createGrepTool(cwd, { operations });

		const result = await tool.execute("grep", { pattern: "needle", context: 1 });

		expect(result.content).toEqual(expectedContent);
		expect(legacyReadFile).not.toHaveBeenCalled();
	});

	it("allows custom operations without a readFile hook", async () => {
		const operations: GrepOperations = { isDirectory: () => true };
		const tool = createGrepTool(cwd, { operations });

		const result = await tool.execute("grep", { pattern: "needle", context: 1 });

		expect(result.content).toEqual(expectedContent);
	});
});
