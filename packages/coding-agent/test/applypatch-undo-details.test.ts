import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPatchTool } from "../src/tools/apply-patch.js";

describe("ApplyPatch undo details", () => {
	let testDir: string;
	let previousCwd: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "coding-agent-applypatch-undo-"));
		previousCwd = process.cwd();
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(testDir, { recursive: true, force: true });
	});

	it("captures undo snapshots for update + add", async () => {
		writeFileSync(join(testDir, "a.txt"), "hello world\n", "utf8");

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-hello world",
			"+hello mu",
			"*** Add File: b.txt",
			"+new file",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchTool.execute("tc_applypatch", { input: patch });
		const details = result.details as unknown as { undo?: unknown };
		expect(details.undo).toBeDefined();

		expect(await readFile(join(testDir, "a.txt"), "utf8")).toBe("hello mu\n");
		expect(await readFile(join(testDir, "b.txt"), "utf8")).toBe("new file\n");
	});

	it("captures undo snapshots for move", async () => {
		writeFileSync(join(testDir, "from.txt"), "one\n", "utf8");

		const patch = [
			"*** Begin Patch",
			"*** Update File: from.txt",
			"*** Move to: to.txt",
			"@@",
			"-one",
			"+two",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchTool.execute("tc_applypatch", { input: patch });
		const details = result.details as unknown as { undo?: unknown };
		expect(details.undo).toBeDefined();

		await expect(readFile(join(testDir, "from.txt"), "utf8")).rejects.toThrow();
		expect(await readFile(join(testDir, "to.txt"), "utf8")).toBe("two\n");
	});
});
