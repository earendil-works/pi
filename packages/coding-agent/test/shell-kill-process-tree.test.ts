import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killProcessTree, killTrackedDetachedChildren, trackDetachedChildPid } from "../src/utils/shell.ts";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawn: spawnMock,
	spawnSync: spawnSyncMock,
}));

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

// Shutdown paths exit right after killing the tracked shells. On Windows an asynchronous taskkill lost
// that race: libuv's job object killed the shell first, and taskkill /T then missed its descendants.
describe("killTrackedDetachedChildren", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		spawnMock.mockReset();
		spawnSyncMock.mockReset();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	});

	it("waits for one taskkill of all tracked trees on Windows", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		trackDetachedChildPid(1234);
		trackDetachedChildPid(5678);

		killTrackedDetachedChildren();

		expect(spawnMock).not.toHaveBeenCalled();
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			expect.stringMatching(/taskkill.exe$/),
			["/F", "/T", "/PID", "1234", "/PID", "5678"],
			expect.objectContaining({ timeout: 2000, windowsHide: true }),
		);

		killTrackedDetachedChildren();
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("kills each tracked process group on POSIX", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
		vi.spyOn(process, "kill").mockReturnValue(true);
		trackDetachedChildPid(1234);

		killTrackedDetachedChildren();

		expect(spawnSyncMock).not.toHaveBeenCalled();
		expect(vi.mocked(process.kill).mock.calls).toEqual([[-1234, "SIGKILL"]]);
	});
});
