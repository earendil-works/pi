import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../../../src/utils/child-process.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/5303
 *
 * waitForChildProcess armed a fixed 100ms timer on `exit` and destroyed the
 * stdio streams when it fired. When a short-lived detached descendant kept the
 * stdout pipe open, `close` never fired, so that timer was the only thing that
 * resolved the wait, and any output written more than 100ms after exit was
 * binned. In practice every git commit whose pre-commit hook runs lint-staged
 * came back truncated mid-listr2 output, read by the model as a hang.
 *
 * The fix re-arms the grace on each chunk, so an actively writing pipe keeps us
 * reading while a genuinely idle held-open handle still releases after the
 * grace elapses. Both behaviours are covered below with virtual time so host
 * load cannot reorder a real subprocess's writes and the grace timer.
 */
describe("issue #5303 bash output truncation past exit", () => {
	function createChild(): ChildProcessByStdio<null, PassThrough, PassThrough> {
		return Object.assign(new EventEmitter(), {
			stdin: null,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		}) as unknown as ChildProcessByStdio<null, PassThrough, PassThrough>;
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("captures output emitted after exit while a descendant holds stdout open", async () => {
		const child = createChild();
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		let resolved = false;
		const waiting = waitForChildProcess(child).then((exitCode) => {
			resolved = true;
			return exitCode;
		});

		child.stdout.write("HEAD\n");
		child.emit("exit", 0, null);
		for (let index = 1; index <= 6; index++) {
			await vi.advanceTimersByTimeAsync(50);
			child.stdout.write(`TICK${index}\n`);
		}
		await vi.advanceTimersByTimeAsync(99);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await waiting).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("TICK6");
	});

	it("resolves after the grace when a descendant holds stdout open but stays quiet", async () => {
		const child = createChild();
		let resolved = false;
		const waiting = waitForChildProcess(child).then((exitCode) => {
			resolved = true;
			return exitCode;
		});

		child.stdout.write("DONE\n");
		child.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(99);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await waiting).toBe(0);
	});
});
