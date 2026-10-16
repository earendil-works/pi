import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

const { existsSyncMock, spawnSyncMock } = vi.hoisted(() => ({
	existsSyncMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	existsSync: existsSyncMock,
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawnSync: spawnSyncMock,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const pwsh7 = "D:\\Applications\\PowerShell\\7\\pwsh.exe";
const windowsPowerShell = "E:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

beforeEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	vi.stubEnv("ProgramFiles", "D:\\Applications");
	vi.stubEnv("SystemRoot", "E:\\WinNT");
	existsSyncMock.mockReset().mockReturnValue(false);
	spawnSyncMock.mockReset().mockReturnValue({ status: 1, stdout: "" });
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

// #9490: discover PowerShell outside PATH without assuming a drive or Windows directory name.
describe("getPowerShellConfig", () => {
	it("prefers PowerShell 7 on PATH over known installation locations", () => {
		const shell = "E:\\Tools\\pwsh.exe";
		spawnSyncMock.mockReturnValue({ status: 0, stdout: `${shell}\r\n` });
		existsSyncMock.mockReturnValue(true);

		expect(getPowerShellConfig()).toEqual({ shell, args: [...POWERSHELL_ARGS] });
	});

	it("finds PowerShell 7 under ProgramFiles before Windows PowerShell on PATH", () => {
		spawnSyncMock.mockImplementation((_command: string, args: string[]) => ({
			status: args[0] === "powershell.exe" ? 0 : 1,
			stdout: args[0] === "powershell.exe" ? windowsPowerShell : "",
		}));
		existsSyncMock.mockImplementation((path: string) => [pwsh7, windowsPowerShell].includes(path));

		expect(getPowerShellConfig()).toEqual({ shell: pwsh7, args: [...POWERSHELL_ARGS] });
	});

	it("prefers Windows PowerShell on PATH over its system installation", () => {
		const shell = "E:\\Tools\\powershell.exe";
		spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({ status: 0, stdout: shell });
		existsSyncMock.mockImplementation((path: string) => [shell, windowsPowerShell].includes(path));

		expect(getPowerShellConfig()).toEqual({ shell, args: [...POWERSHELL_ARGS] });
	});

	it("finds Windows PowerShell under SystemRoot when PATH lookup is unavailable", () => {
		spawnSyncMock.mockReturnValue({ status: null, stdout: null, error: new Error("spawn where ENOENT") });
		existsSyncMock.mockImplementation((path: string) => path === windowsPowerShell);

		expect(getPowerShellConfig()).toEqual({ shell: windowsPowerShell, args: [...POWERSHELL_ARGS] });
	});

	it("reports an error when no PowerShell installation exists", () => {
		expect(() => getPowerShellConfig()).toThrow("No PowerShell executable found");
	});
});
