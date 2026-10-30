import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/utils/shell.ts";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

// Regression coverage for #11252: stop-before-kill is macOS-only and best-effort.
describe("killProcessTree", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		vi.spyOn(process, "kill").mockReturnValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	});

	it("stops the macOS process group before killing it without resuming it", () => {
		killProcessTree(1234);

		expect(vi.mocked(process.kill).mock.calls).toEqual([
			[-1234, "SIGSTOP"],
			[-1234, "SIGKILL"],
		]);
	});

	it("still kills the group when stopping fails", () => {
		vi.mocked(process.kill).mockImplementationOnce(() => {
			throw new Error("stop failed");
		});

		killProcessTree(1234);

		expect(vi.mocked(process.kill).mock.calls).toEqual([
			[-1234, "SIGSTOP"],
			[-1234, "SIGKILL"],
		]);
	});

	it("falls back to killing the shell when the group kill fails", () => {
		vi.mocked(process.kill).mockImplementation((pid, signal) => {
			if (pid < 0 && signal === "SIGKILL") throw new Error("group kill failed");
			return true;
		});

		killProcessTree(1234);

		expect(vi.mocked(process.kill).mock.calls).toEqual([
			[-1234, "SIGSTOP"],
			[-1234, "SIGKILL"],
			[1234, "SIGKILL"],
		]);
	});

	it("tolerates failure of both group signals and the fallback", () => {
		vi.mocked(process.kill).mockImplementation(() => {
			throw new Error("process no longer exists");
		});

		expect(() => killProcessTree(1234)).not.toThrow();
		expect(vi.mocked(process.kill).mock.calls).toEqual([
			[-1234, "SIGSTOP"],
			[-1234, "SIGKILL"],
			[1234, "SIGKILL"],
		]);
	});

	it("keeps Linux group termination unchanged", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

		killProcessTree(1234);

		expect(vi.mocked(process.kill).mock.calls).toEqual([[-1234, "SIGKILL"]]);
	});
});
