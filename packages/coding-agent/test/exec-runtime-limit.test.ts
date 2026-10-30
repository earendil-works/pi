import * as buffer from "node:buffer";
import { expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

vi.mock("node:buffer", async (importOriginal) => {
	const actual = await importOriginal<typeof buffer>();
	return {
		...actual,
		// 32-bit Node's maximum is 16 bytes below 256 MiB.
		constants: { ...actual.constants, MAX_STRING_LENGTH: 268_435_440 },
	};
});

// Regression tests for https://github.com/earendil-works/pi/issues/11360
it("executes with the default cap when the runtime string limit is below 256 MiB", async () => {
	const result = await execCommand(process.execPath, ["-e", 'process.stdout.write("ok")'], process.cwd());

	expect(result).toEqual({ stdout: "ok", stderr: "", code: 0, killed: false, truncated: false });
});

it("still rejects an explicit cap above the runtime string limit", async () => {
	await expect(
		execCommand(process.execPath, ["-e", ""], process.cwd(), { maxBuffer: buffer.constants.MAX_STRING_LENGTH + 1 }),
	).rejects.toThrow(RangeError);
});
