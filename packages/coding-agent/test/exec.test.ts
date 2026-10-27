import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	// Regression test for https://github.com/earendil-works/pi/issues/11085
	it("reports spawn errors in stderr", async () => {
		const result = await execCommand("pi-command-that-does-not-exist-11085", [], process.cwd());

		expect(result).toMatchObject({
			code: 1,
			killed: false,
			stdout: "",
		});
		expect(result.stderr).toMatch(/ENOENT/);
	});

	it("keeps stderr empty when a command exits silently", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(1)"], process.cwd());

		expect(result).toEqual({ stdout: "", stderr: "", code: 1, killed: false });
	});
});
