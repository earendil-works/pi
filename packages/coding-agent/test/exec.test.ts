import { constants as bufferConstants } from "node:buffer";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	// Regression test for https://github.com/earendil-works/pi/issues/11085
	it("reports spawn errors in stderr", async () => {
		const result = await execCommand("pi-command-that-does-not-exist-11085", [], process.cwd());

		expect(result).toMatchObject({
			code: 1,
			killed: false,
			truncated: false,
			stdout: "",
		});
		expect(result.stderr).toMatch(/ENOENT/);
	});

	it("keeps stderr empty when a command exits silently", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(1)"], process.cwd());

		expect(result).toEqual({ stdout: "", stderr: "", code: 1, killed: false, truncated: false });
	});

	// Regression tests for https://github.com/earendil-works/pi/issues/11360
	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		bufferConstants.MAX_STRING_LENGTH + 1,
	])("rejects invalid maxBuffer %s instead of attempting execution", async (maxBuffer) => {
		// A missing command normally resolves to a failed result; invalid options must reject instead.
		await expect(
			execCommand("pi-command-that-does-not-exist-11360", [], process.cwd(), { maxBuffer }),
		).rejects.toThrow(RangeError);
	});

	it.each([0, bufferConstants.MAX_STRING_LENGTH])("accepts maxBuffer boundary %s", async (maxBuffer) => {
		const result = await execCommand(process.execPath, ["-e", ""], process.cwd(), { maxBuffer });

		expect(result).toEqual({ stdout: "", stderr: "", code: 0, killed: false, truncated: false });
	});

	it("truncates all output when maxBuffer is zero", async () => {
		const result = await execCommand(process.execPath, ["-e", 'process.stdout.write("x")'], process.cwd(), {
			maxBuffer: 0,
		});

		expect(result).toMatchObject({ stdout: "", stderr: "", truncated: true, killed: true });
		expect(result.code).not.toBe(0);
	});

	it("caps combined output at maxBuffer, terminates the command, and reports truncation", async () => {
		const script =
			'process.stderr.write("e".repeat(600)); process.stdout.write("o".repeat(600)); setInterval(() => process.stdout.write("x".repeat(1000)), 10);';
		const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { maxBuffer: 1000 });

		expect(result).toMatchObject({ truncated: true, killed: true });
		expect(result.code).not.toBe(0);
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1000);
	});

	// #11360: a byte cap must not turn a partial UTF-8 character into replacement output.
	it.each([
		["stdout", "€", 1, ""],
		["stderr", "€", 1, ""],
		["stdout", "a€🙂", 5, "a€"],
		["stderr", "a€🙂", 5, "a€"],
	] as const)(
		"keeps complete UTF-8 characters from %s output %s capped at %i bytes",
		async (stream, output, maxBuffer, expected) => {
			const script = `process.${stream}.write(${JSON.stringify(output)})`;
			const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { maxBuffer });

			expect(result).toMatchObject({ [stream]: expected, truncated: true, killed: true });
			expect(result.code).not.toBe(0);
			expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxBuffer);
		},
	);

	it("still flushes incomplete UTF-8 at normal EOF when output was not truncated", async () => {
		const script = "process.stdout.write(Buffer.from([0xe2])); process.stderr.write(Buffer.from([0xf0]));";
		const result = await execCommand(process.execPath, ["-e", script], process.cwd());

		expect(result).toEqual({ stdout: "�", stderr: "�", code: 0, killed: false, truncated: false });
	});

	it("leaves output up to maxBuffer unchanged", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", 'process.stdout.write("a".repeat(1000))'],
			process.cwd(),
			{
				maxBuffer: 1000,
			},
		);

		expect(result).toEqual({ stdout: "a".repeat(1000), stderr: "", code: 0, killed: false, truncated: false });
	});

	it.skipIf(process.platform === "win32")(
		"returns when a shell's child keeps writing after the shell is terminated",
		async () => {
			// SIGTERM kills only `sh`; `yes` keeps the output pipes open and writing.
			const result = await execCommand("sh", ["-c", "yes; echo done"], process.cwd(), { maxBuffer: 1000 });

			expect(result).toMatchObject({ killed: true, truncated: true });
			expect(result.stdout).toBe("y\n".repeat(500));
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"force-kills a command that ignores SIGTERM",
		async () => {
			// The handler is installed before the first write, so the kill triggered by maxBuffer
			// cannot arrive before the child ignores SIGTERM.
			const script = 'process.on("SIGTERM", () => {}); process.stdout.write("xx"); setInterval(() => {}, 1000);';
			const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { maxBuffer: 1 });

			expect(result).toMatchObject({ stdout: "x", killed: true, truncated: true });
			expect(result.code).not.toBe(0);
		},
		15_000,
	);
});
