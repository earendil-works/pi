import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/5303
 *
 * When a child exits but a detached descendant keeps the stdout pipe open
 * without writing, `close` never fires, so waitForChildProcess must still
 * resolve via the post-exit grace rather than hang on the inherited handle.
 * Pin this behaviour before reworking the grace so the fix cannot regress it.
 */
describe.skipIf(process.platform === "win32")("issue #5303 bash output truncation past exit", () => {
	let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

	afterEach(() => {
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		child = undefined;
	});

	it("resolves promptly when a detached child holds stdout open but stays quiet", async () => {
		// The shell exits, but a backgrounded sleeper inherits the stdout pipe and
		// keeps it open for a long time without writing. `close` never fires, so we
		// must still release via the idle grace rather than hang on the open handle.
		const command = 'printf "DONE\\n"; ( sleep 30 ) &';
		child = spawnProcess("/bin/sh", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const start = Date.now();
		const exitCode = await waitForChildProcess(child);
		const elapsed = Date.now() - start;

		expect(exitCode).toBe(0);
		expect(output).toContain("DONE");
		// Must not wait for the 30s sleeper; the idle grace releases us in well under a second.
		expect(elapsed).toBeLessThan(2000);
	});
});
