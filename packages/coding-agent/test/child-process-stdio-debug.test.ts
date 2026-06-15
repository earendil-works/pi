import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PI_STDIO_DEBUG surfaces the held-open-pipe case that #5753 left in place: a
 * child that exits while a detached descendant keeps emitting on the inherited
 * stdout pipe. We keep reading rather than truncate the tail, which means a
 * descendant writing continuously can hold the wait open until the command's own
 * timeout. The flag makes that diagnosable instead of reading as a silent hang.
 *
 * STDIO_DEBUG is read once at module load, so each case re-imports the module
 * under the desired env via vi.resetModules().
 */
async function loadWaitForChildProcess(debug: boolean): Promise<typeof import("../src/utils/child-process.ts")> {
	vi.resetModules();
	if (debug) {
		vi.stubEnv("PI_STDIO_DEBUG", "1");
	} else {
		vi.stubEnv("PI_STDIO_DEBUG", "");
	}
	return import("../src/utils/child-process.ts");
}

describe.skipIf(process.platform === "win32")("PI_STDIO_DEBUG held-open-pipe diagnostic", () => {
	let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		child = undefined;
	});

	// The shell exits immediately; a backgrounded subshell keeps stdout open and
	// emits ticks every 50ms past exit. Each chunk re-arms the grace, so the wait
	// is held open by output rather than released at the fixed deadline.
	const heldOpenCommand = 'printf "HEAD\\n"; ( for i in 1 2 3 4; do sleep 0.05; printf "TICK$i\\n"; done ) &';

	it("logs how long a process held stdio open past exit when enabled", async () => {
		const { spawnProcess, waitForChildProcess } = await loadWaitForChildProcess(true);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		child = spawnProcess("/bin/sh", ["-c", heldOpenCommand], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;
		child.stdout.on("data", () => {});

		const exitCode = await waitForChildProcess(child);

		expect(exitCode).toBe(0);
		const line = errorSpy.mock.calls.map((args) => String(args[0])).find((text) => text.includes("[stdio]"));
		expect(line).toBeDefined();
		expect(line).toContain("held stdio open");
		expect(line).toMatch(/\d+ms past exit/);
	});

	it("stays silent when the flag is unset", async () => {
		const { spawnProcess, waitForChildProcess } = await loadWaitForChildProcess(false);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		child = spawnProcess("/bin/sh", ["-c", heldOpenCommand], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;
		child.stdout.on("data", () => {});

		const exitCode = await waitForChildProcess(child);

		expect(exitCode).toBe(0);
		expect(errorSpy.mock.calls.some((args) => String(args[0]).includes("[stdio]"))).toBe(false);
	});
});
