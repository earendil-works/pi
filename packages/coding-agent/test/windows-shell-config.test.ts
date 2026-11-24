import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";

const { accessSyncMock, spawnSyncMock } = vi.hoisted(() => ({
	accessSyncMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync: accessSyncMock,
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawnSync: spawnSyncMock,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	accessSyncMock.mockReset();
	spawnSyncMock.mockReset().mockReturnValue({ status: 1, stdout: "" });
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

// #12408: find Git Bash of a Git for Windows installed outside Program Files through git on PATH.
describe("Git Bash discovery through git on PATH", () => {
	const git = "G:\\Programmi Aggiuntivi\\Git\\cmd\\git.exe";
	const gitBash = "G:\\Programmi Aggiuntivi\\Git\\bin\\bash.exe";
	const wslBash = "C:\\Windows\\System32\\bash.exe";

	beforeEach(() => {
		vi.stubEnv("ProgramFiles", "C:\\Program Files");
		vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
		vi.stubEnv("SystemRoot", "C:\\Windows");
	});

	function installed(...paths: string[]): void {
		accessSyncMock.mockImplementation((path: string) => {
			if (!paths.includes(path)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});
	}

	function onPath(gitShellPath: string | null): void {
		spawnSyncMock.mockImplementation((command: string, args: string[]) => {
			if (command === "where") {
				const found = { "git.exe": git, "bash.exe": wslBash }[args[0]];
				return found ? { status: 0, stdout: `${found}\r\n` } : { status: 1, stdout: "" };
			}
			if (command === git && args.join(" ") === "var GIT_SHELL_PATH") {
				return gitShellPath === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${gitShellPath}\n` };
			}
			throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
		});
	}

	it("prefers Git Bash of git on PATH over the WSL launcher on PATH", () => {
		installed(git, gitBash, wslBash);
		onPath("G:/Programmi Aggiuntivi/Git/usr/bin/sh.exe");

		expect(getShellConfig()).toEqual({ shell: gitBash, args: ["-c"] });
	});

	it("keeps Git Bash under ProgramFiles first without running git", () => {
		const programFilesBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		installed(programFilesBash, git, gitBash);
		onPath("G:/Programmi Aggiuntivi/Git/usr/bin/sh.exe");

		expect(getShellConfig()).toEqual({ shell: programFilesBash, args: ["-c"] });
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it.each([
		["git without GIT_SHELL_PATH (before 2.47)", null],
		["a shell outside a Git for Windows layout", "G:/Tools/sh.exe"],
		["a Git for Windows root without its Bash launcher", "G:/Programmi Aggiuntivi/Other/usr/bin/sh.exe"],
	])("falls back to bash.exe on PATH for %s", (_name, gitShellPath) => {
		installed(git, gitBash, wslBash);
		onPath(gitShellPath);

		expect(getShellConfig()).toEqual({ shell: wslBash, args: ["-s"], commandTransport: "stdin" });
	});
});
