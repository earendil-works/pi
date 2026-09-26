import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreStdout, takeOverStdout, writeRawStdout } from "../src/core/output-guard.ts";

/**
 * A terminal that goes away makes stdout writes fail with EPIPE/ECONNRESET.
 * The old behaviour was `process.exit(1)`, which killed the TUI with no message,
 * no terminal restore, and no final transcript entry. These tests pin the
 * graceful path instead.
 */
describe("writeRawStdout when the terminal is gone", () => {
	afterEach(() => {
		restoreStdout();
		vi.restoreAllMocks();
	});

	function breakStdout(code: string) {
		takeOverStdout();
		const broken = (
			_chunk: string,
			cb?: (error?: Error | null) => void,
		): boolean => {
			const err = Object.assign(new Error("write EPIPE"), { code });
			// Write streams report through the callback, asynchronously.
			queueMicrotask(() => cb?.(err));
			return false;
		};
		// The takeover redirects stdout to stderr, so patch the raw handle the
		// guard captured by forcing a fresh takeover around a broken stdout.
		vi.spyOn(process.stdout, "write").mockImplementation(broken as never);
	}

	it("does not call process.exit", async () => {
		breakStdout("EPIPE");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as never);
		writeRawStdout("hello");
		await new Promise((r) => setTimeout(r, 50));
		expect(exit).not.toHaveBeenCalled();
	});

	it("reports the reason on stderr exactly once", async () => {
		breakStdout("EPIPE");
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		writeRawStdout("one");
		writeRawStdout("two");
		await new Promise((r) => setTimeout(r, 50));
		const text = err.mock.calls.map((c) => String(c[0])).join("");
		expect(text).toContain("EPIPE");
		expect(text).toContain("--continue");
		// One shutdown line, not one per failed write.
		expect(text.split("pi: stdout write failed").length - 1).toBe(1);
	});
});
