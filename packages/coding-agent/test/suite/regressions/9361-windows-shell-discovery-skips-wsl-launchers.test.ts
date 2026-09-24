import * as fs from "node:fs";
import * as childProcess from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPowerShellConfig, getShellConfig } from "../../../src/utils/shell.ts";

vi.mock("node:fs", { spy: true });
vi.mock("child_process", { spy: true });

// #9361: PATH discovery must not silently move local commands into WSL.
describe("Windows shell discovery", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const nativeBash = "E:\\laragon\\bin\\git\\bin\\bash.exe";
	const wslBash = "C:\\Windows\\System32\\bash.exe";
	const available = new Set<string>();
	let pathMatches: string[];

	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		vi.stubEnv("ProgramFiles", "C:\\Program Files");
		vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
		vi.stubEnv("SystemRoot", "C:\\Windows");
		pathMatches = [wslBash, nativeBash];
		available.clear();
		available.add(wslBash);
		available.add(nativeBash);
		vi.spyOn(fs, "existsSync").mockImplementation((path) => available.has(String(path)));
		vi.spyOn(childProcess, "spawnSync").mockImplementation(() => {
			const stdout = pathMatches.join("\r\n");
			return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		Object.defineProperty(process, "platform", originalPlatform);
	});

	it("honors a configured nonstandard Git Bash before discovery", () => {
		expect(getShellConfig(nativeBash)).toEqual({ shell: nativeBash, args: ["-c"] });
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});

	it.each([wslBash, "C:\\Windows\\Sysnative\\bash.exe", "D:\\WinNT\\System32\\bash.exe"])(
		"skips the implicit WSL launcher %s and continues searching PATH",
		(launcher) => {
			vi.stubEnv("SystemRoot", launcher.startsWith("D:") ? "D:\\WinNT" : "C:\\Windows");
			available.add(launcher);
			pathMatches = [launcher, nativeBash];
			expect(getShellConfig()).toEqual({ shell: nativeBash, args: ["-c"] });
		},
	);

	it("fails when only the implicit WSL launcher is available and reports it", () => {
		pathMatches = [wslBash];
		expect(() => getShellConfig()).toThrow(
			/No bash shell found[\s\S]*Skipped WSL launchers[\s\S]*System32\\bash\.exe/,
		);
	});

	it("retains explicitly configured WSL and its stdin transport", () => {
		expect(getShellConfig(wslBash)).toEqual({ shell: wslBash, args: ["-s"], commandTransport: "stdin" });
	});

	it("reports a missing configured path without falling back", () => {
		const missing = "E:\\missing\\bash.exe";
		expect(() => getShellConfig(missing)).toThrow(`Custom shell path not found: ${missing}`);
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});

	it("continues past nonexistent where results", () => {
		pathMatches = ["E:\\missing\\bash.exe", nativeBash];
		expect(getShellConfig()).toEqual({ shell: nativeBash, args: ["-c"] });
	});

	it("preserves PowerShell discovery", () => {
		const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		available.add(powershell);
		pathMatches = [powershell];
		expect(getPowerShellConfig().shell).toBe(powershell);
	});
});
