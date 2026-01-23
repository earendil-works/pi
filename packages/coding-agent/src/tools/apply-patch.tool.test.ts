import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runApplyPatchCharacterizationWithRunner } from "./apply-patch/characterization.js";
import type { ApplyPatchRunOptions, ApplyPatchRunResult } from "./apply-patch/runner.js";
import { applyPatchTool } from "./apply-patch.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(currentDir, "apply-patch", "__fixtures__", "apply-patch.golden.txt");

async function runApplyPatchTool(options: ApplyPatchRunOptions): Promise<ApplyPatchRunResult> {
	const previousCwd = process.cwd();
	process.chdir(options.cwd);

	try {
		const result = await applyPatchTool.execute("test", { input: options.patch }, options.signal);
		const stdout = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
		return {
			exitCode: 0,
			stdout,
			stderr: "",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exitCode: 1,
			stdout: "",
			stderr: message,
		};
	} finally {
		process.chdir(previousCwd);
	}
}

describe("ApplyPatch tool", () => {
	it("matches the golden master output", async () => {
		const output = await runApplyPatchCharacterizationWithRunner(runApplyPatchTool);
		const golden = await readFile(fixturePath, "utf8");
		expect(output).toBe(golden);
	}, 30000);
});
