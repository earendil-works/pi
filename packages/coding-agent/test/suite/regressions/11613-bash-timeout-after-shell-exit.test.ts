import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../../../src/core/tools/bash.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/11613
 *
 * The bash tool waits for stdout/stderr to close, not only for the shell to exit (#5303). A background
 * process that inherited those pipes and keeps writing keeps the tool waiting after the shell exited.
 * When the timeout then hit, the tool reported only "Command timed out", so the shell's real exit code
 * and the fact that it had already finished were lost. The tool now reports both.
 *
 * Unix only: on Windows the deadline cannot kill background processes once the shell pid is gone, so the
 * tool keeps waiting until their output pauses; this test would hang there.
 */
describe.skipIf(process.platform === "win32")("issue #11613 bash timeout after the shell exited", () => {
	const bashTool = createBashTool(tmpdir());

	async function runExpectingTimeout(command: string, timeout: number): Promise<string> {
		const error = await bashTool.execute("test-11613", { command, timeout }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(Error);
		return (error as Error).message;
	}

	it("reports the shell's exit code when background processes kept writing until the timeout", async () => {
		const message = await runExpectingTimeout(
			"(while true; do echo tick; sleep 0.02; done) & sleep 0.2; echo boom >&2; exit 3",
			1,
		);
		expect(message).toContain("boom");
		expect(message).toMatch(
			/Command timed out after 1 seconds\. The shell exited with code 3 after 0\.\d seconds, but background processes it started kept writing output until the timeout\.$/,
		);
	});

	it("keeps the plain timeout message when the shell was still running at the deadline", async () => {
		const message = await runExpectingTimeout("echo started; sleep 30", 0.3);
		expect(message).toMatch(/started\s+Command timed out after 0\.3 seconds$/);
	});
});
