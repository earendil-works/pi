import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchFreeformTool } from "./apply-patch-freeform.js";

describe("apply_patch (freeform) tool", () => {
	let tempDir: string | null = null;
	let originalCwd: string | null = null;

	afterEach(async () => {
		if (originalCwd) {
			process.chdir(originalCwd);
			originalCwd = null;
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("accepts a freeform patch string and writes files", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mu-apply-patch-"));
		originalCwd = process.cwd();
		process.chdir(tempDir);

		const patch = ["*** Begin Patch", "*** Add File: hello.txt", "+Hello, world!", "*** End Patch", ""].join("\n");

		await applyPatchFreeformTool.execute("toolcall_1", patch);

		const content = await readFile(join(tempDir, "hello.txt"), "utf8");
		expect(content).toBe("Hello, world!\n");
	});
});
