import type * as FsModule from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWSL } from "../src/utils/wsl.ts";

const mocks = vi.hoisted(() => ({ readFileSync: vi.fn<(path: string, encoding: string) => string>() }));
vi.mock("node:fs", async () => ({
	...(await vi.importActual<typeof FsModule>("node:fs")),
	readFileSync: mocks.readFileSync,
}));

const WSL2_RELEASE = "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@...) #1 SMP PREEMPT_DYNAMIC";
const LINUX_RELEASE = "Linux version 6.8.0-45-generic (buildd@...) #45-Ubuntu SMP PREEMPT_DYNAMIC";

describe("isWSL", () => {
	beforeEach(() => {
		mocks.readFileSync.mockReset();
		mocks.readFileSync.mockReturnValue(LINUX_RELEASE);
	});

	it.each([{ WSL_DISTRO_NAME: "Ubuntu" }, { WSL_INTEROP: "/run/WSL/123_interop" }, { WSLENV: "WT_SESSION/u" }])(
		"detects WSL from %j without reading /proc/version",
		(env) => {
			expect(isWSL("linux", env)).toBe(true);
			expect(mocks.readFileSync).not.toHaveBeenCalled();
		},
	);

	it("detects WSL from the kernel release when the WSL variables are missing", () => {
		// A shell started by a systemd user service (the Rex terminal) has no WSL variables.
		mocks.readFileSync.mockReturnValue(WSL2_RELEASE);
		expect(isWSL("linux", {})).toBe(true);
		expect(mocks.readFileSync).toHaveBeenCalledWith("/proc/version", "utf-8");
	});

	it("is false on plain Linux and when /proc/version cannot be read", () => {
		expect(isWSL("linux", {})).toBe(false);
		mocks.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(isWSL("linux", {})).toBe(false);
	});

	it("is false on other platforms, even with WSL variables set", () => {
		// Windows can carry WSLENV in its own environment.
		expect(isWSL("win32", { WSLENV: "WT_SESSION/u" })).toBe(false);
		expect(isWSL("darwin", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(false);
		expect(mocks.readFileSync).not.toHaveBeenCalled();
	});
});
