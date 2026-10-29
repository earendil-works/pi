import type * as ChildProcessModule from "node:child_process";
import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawn: vi.fn(),
}));

// #11360: real streams control chunk boundaries without relying on OS pipe timing.
// Only process creation and termination are stubbed; decoding and process waiting are real.
it.each(["stdout", "stderr"] as const)(
	"discards pending %s UTF-8 bytes when either stream exceeds the cap",
	async (stream) => {
		const child = new ChildProcess();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdout = stdout;
		child.stderr = stderr;
		vi.mocked(spawn).mockReturnValueOnce(child);
		vi.spyOn(child, "kill").mockImplementation(() => {
			queueMicrotask(() => {
				child.emit("exit", null, "SIGTERM");
				child.emit("close", null, "SIGTERM");
			});
			return true;
		});

		const resultPromise = execCommand("test-command", [], process.cwd(), { maxBuffer: 3 });
		const output = stream === "stdout" ? stdout : stderr;
		const otherOutput = stream === "stdout" ? stderr : stdout;
		// The decoder first returns "a" and buffers the first byte of €.
		output.write(Buffer.from([0x61, 0xe2]));
		await setImmediate();
		// The other decoder also buffers the first byte of € before the shared cap is exceeded.
		otherOutput.write(Buffer.from([0xe2]));
		await setImmediate();
		output.write(Buffer.from([0x82, 0xac]));

		const result = await resultPromise;
		expect(result).toMatchObject({
			stdout: stream === "stdout" ? "a" : "",
			stderr: stream === "stderr" ? "a" : "",
			truncated: true,
			killed: true,
		});
		expect(result.code).not.toBe(0);
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(3);
	},
);
