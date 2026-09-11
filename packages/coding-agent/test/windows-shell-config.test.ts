import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	existsSync: () => true,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

// #9490: identify legacy WSL launchers under the actual Windows directory.
describe("legacy WSL bash detection", () => {
	it.each([
		["D:\\WinNT\\", "d:/WINNT/System32/BASH.EXE", true],
		["D:\\WinNT", "D:\\WinNT\\Sysnative\\bash.exe", true],
		[undefined, "E:\\Windows\\System32\\bash.exe", true],
		["D:\\WinNT", "D:\\Git\\bin\\bash.exe", false],
		["D:\\WinNT", "E:\\Windows\\System32\\bash.exe", false],
		["WinNT", "C:\\Windows\\System32\\bash.exe", false],
	] as const)("resolves %j / %j to stdin=%j", (systemRoot, shell, stdin) => {
		vi.stubEnv("SystemRoot", systemRoot);

		expect(getShellConfig(shell)).toEqual(
			stdin ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] },
		);
	});
});
