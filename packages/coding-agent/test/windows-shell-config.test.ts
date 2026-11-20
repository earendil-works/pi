import type * as Fs from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalShellOperations } from "../src/core/tools/bash.ts";
import { getShellConfig, SHELL_COMMAND_ENV_VAR, type ShellConfig } from "../src/utils/shell.ts";

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync: () => {},
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const hostPlatform = process.platform;

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
	] as const)("resolves %j / %j to legacy WSL=%j", (systemRoot, shell, legacyWsl) => {
		vi.stubEnv("SystemRoot", systemRoot);

		expect(getShellConfig(shell).commandTransport).toBe(legacyWsl ? "stdin" : "env");
	});
});

// #12340: the Cygwin runtime of Windows bash builds silently cuts quoted argv arguments after
// about 8 KB and splits unquoted ones at newlines.
describe("Windows bash command transport", () => {
	it.each([
		["C:\\Program Files\\Git\\bin\\bash.exe", "env"],
		["C:\\msys64\\usr\\bin\\bash", "env"],
		["C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", undefined],
		["C:\\Program Files\\Git\\usr\\bin\\dash.exe", undefined],
		["C:\\Program Files\\PowerShell\\7\\pwsh.exe", undefined],
	] as const)("resolves %j to transport %j", (shell, transport) => {
		expect(getShellConfig(shell).commandTransport).toBe(transport);
	});

	it.skipIf(hostPlatform === "win32")("keeps argv transport off Windows", () => {
		Object.defineProperty(process, "platform", platformDescriptor);

		expect(getShellConfig("/usr/bin/bash")).toEqual({ shell: "/usr/bin/bash", args: ["-c"] });
	});

	const hostBash = hostPlatform === "win32" ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : "/bin/bash";

	async function runCommand(
		command: string,
		config?: ShellConfig,
	): Promise<{ exitCode: number | null; output: string }> {
		const shellConfig = config ?? getShellConfig(hostBash);
		Object.defineProperty(process, "platform", platformDescriptor);
		const chunks: Buffer[] = [];
		const operations = createLocalShellOperations("bash", () => shellConfig);
		const { exitCode } = await operations.exec(command, tmpdir(), { onData: (data) => chunks.push(data) });
		return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
	}

	it.skipIf(!existsSync(hostBash))("runs commands longer than the argv truncation limit in full", async () => {
		const command = `printf 'START\\n'; # ${"a ".repeat(10_000)}\nprintf 'DONE\\n'`;

		expect(await runCommand(command)).toEqual({ exitCode: 0, output: "START\nDONE\n" });
	});

	it.skipIf(!existsSync(hostBash))("runs newline-separated commands without spaces in full", async () => {
		// Split at the newline, `bash -c true` would run with `$0` set to `false` and exit 0.
		expect(await runCommand("true\nfalse")).toEqual({ exitCode: 1, output: "" });
	});

	it.skipIf(!existsSync(hostBash))("keeps argv command semantics for status, stdin and exit", async () => {
		const command = `printf 'status=%s\\n' "$?"; [ -c /dev/stdin ] && echo stdin=device\nexit 7`;

		expect(await runCommand(command)).toEqual({ exitCode: 7, output: "status=0\nstdin=device\n" });
	});

	it.skipIf(!existsSync(hostBash))("hides the command variable from the command and its children", async () => {
		const command = `printf '%s\\n' "\${${SHELL_COMMAND_ENV_VAR}-unset}"; env | grep -c ${SHELL_COMMAND_ENV_VAR}`;

		expect(await runCommand(command)).toEqual({ exitCode: 1, output: "unset\n0\n" });
	});

	it.skipIf(!existsSync(hostBash))("fails when a caller appends the command to args instead", async () => {
		const config = getShellConfig(hostBash);
		const argvConfig: ShellConfig = { ...config, commandTransport: "argv" };

		expect((await runCommand("echo appended", argvConfig)).exitCode).not.toBe(0);
	});
});
