import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runSpawnedCommand, type SpawnedProcess, type SpawnFn } from "./spawn-cli.js";

function makeFakeProcess(params: {
	stdoutChunks?: string[];
	stderrChunks?: string[];
	exitCode?: number | null;
}): SpawnedProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();

	const listeners = {
		error: [] as Array<(err: Error) => void>,
		close: [] as Array<(code: number | null) => void>,
	};

	let proc: SpawnedProcess;
	proc = {
		stdout,
		stderr,
		kill: () => true,
		on: ((event: "close" | "error", handler: unknown) => {
			if (event === "close") {
				listeners.close.push(handler as (code: number | null) => void);
			} else {
				listeners.error.push(handler as (err: Error) => void);
			}
			return proc;
		}) as SpawnedProcess["on"],
	};

	queueMicrotask(() => {
		for (const chunk of params.stdoutChunks ?? []) stdout.write(chunk);
		for (const chunk of params.stderrChunks ?? []) stderr.write(chunk);
		stdout.end();
		stderr.end();
		for (const cb of listeners.close) cb(params.exitCode ?? 0);
	});

	return proc;
}

describe("runSpawnedCommand", () => {
	it("captures stdout+stderr and returns them (success)", async () => {
		const spawn: SpawnFn = vi.fn(() =>
			makeFakeProcess({ stdoutChunks: ["out1\n", "out2\n"], stderrChunks: ["err1\n"], exitCode: 0 }),
		);

		const res = await runSpawnedCommand({
			command: "webfetch",
			args: ["https://example.com"],
			spawn,
		});

		expect(spawn).toHaveBeenCalledWith(
			"webfetch",
			["https://example.com"],
			expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
		);

		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("out1\nout2\n");
		expect(res.stderr).toBe("err1\n");
		// Order is based on event delivery (stdout then stderr in this fake).
		expect(res.combined).toBe("out1\nout2\nerr1\n");
	});

	it("rejects with stderr+stdout included when exit code is non-zero", async () => {
		const spawn: SpawnFn = vi.fn(() =>
			makeFakeProcess({ stdoutChunks: ["out\n"], stderrChunks: ["err\n"], exitCode: 7 }),
		);

		await expect(
			runSpawnedCommand({
				command: "websearch",
				args: ["query", "hello"],
				spawn,
			}),
		).rejects.toThrow(/exit code 7/);
	});
});
