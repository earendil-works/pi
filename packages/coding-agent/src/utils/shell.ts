import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "child_process";
import { getBinDir, getWindowsJobHelperPath } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

// Keep in sync with packages/durable/src/env/node.ts.
function isLegacyWslBashPath(path: string): boolean {
	const normalized = win32.normalize(path).toLowerCase();
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
		return ["System32", "Sysnative"].some(
			(directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
		);
	}
	// Fall back to conventional launcher paths only when the Windows directory is unknown.
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

// Matches harness-v2's pathExists (packages/durable/src/env/node.ts).
// On Unix this is identical to existsSync() (both are access(F_OK)), just
// spelled with try/catch. On Windows we explicitly avoid existsSync(): its
// extra stat check rejects runnable Store aliases (nodejs/node#36790).
function shellPathExists(path: string): boolean {
	try {
		accessSync(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows: use 'where' and check the returned path.
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && shellPathExists(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (shellPathExists(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (shellPathExists(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (shellPathExists("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	let shell = findExecutableOnPath("pwsh.exe");
	// Installation directories may be on any drive and need not be on PATH.
	const programFiles = process.env.ProgramFiles;
	if (!shell && programFiles) {
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		if (shellPathExists(pwsh7)) shell = pwsh7;
	}

	shell ??= findExecutableOnPath("powershell.exe");
	const systemRoot = process.env.SystemRoot;
	if (!shell && systemRoot) {
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (shellPathExists(windowsPowerShell)) shell = windowsPowerShell;
	}

	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode interlinear annotation characters U+FFF9..U+FFFB (crash string-width due to a bug)
 */
export function sanitizeBinaryOutput(str: string): string {
	// All removed characters are single UTF-16 code units, so surrogate pairs are never split.
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/** A spawned command whose processes, including ones it started in the background, can be killed as one unit. */
export interface ProcessTree {
	readonly child: ChildProcess;
	/** Kill the command and every process it started; also works after the command itself exited. */
	kill(): void;
}

/**
 * Spawn a command as a process tree: on Unix in a new process group, on Windows in a named job object.
 *
 * Windows has no process groups, and `taskkill /T` finds descendants through their parent pid. Once the shell
 * exits, a background process it started has no living parent and cannot be found: in
 * `(while true; do echo tick; sleep 1; done) & exit 1`, killing the shell's pid leaves the loop writing to
 * pi's pipes (#11613). pi-job.exe starts the command in a job object, which every descendant joins and cannot
 * leave, and `kill()` terminates the job by name. Without the helper (unexpected layouts), the taskkill path
 * remains. A missing command also takes it, so it fails with Node's spawn error (ENOENT) instead of an exit code.
 */
export function spawnProcessTree(command: string, args: string[], options: SpawnOptions): ProcessTree {
	const helper = process.platform === "win32" ? getWindowsJobHelperPath() : undefined;
	if (helper && shellPathExists(helper) && shellPathExists(command)) {
		const jobName = `pi-${process.pid}-${randomUUID()}`;
		const child = spawn(helper, ["run", jobName, command, ...args], options);
		return {
			child,
			kill: () => {
				// Killing pi-job covers the moment before it created the job (the command never starts) and closes
				// the job's last handle while it runs; `terminate` reaches processes left after the command exited.
				child.kill();
				spawnCleanup(helper, ["terminate", jobName]);
			},
		};
	}
	const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
	return {
		child,
		kill: () => {
			if (child.pid) killProcessTree(child.pid);
		},
	};
}

/**
 * Process trees of running commands, killed on parent shutdown signals (SIGHUP/SIGTERM).
 */
const trackedProcessTrees = new Set<ProcessTree>();

export function trackProcessTree(tree: ProcessTree): void {
	trackedProcessTrees.add(tree);
}

export function untrackProcessTree(tree: ProcessTree): void {
	trackedProcessTrees.delete(tree);
}

export function killTrackedProcessTrees(): void {
	for (const tree of trackedProcessTrees) {
		tree.kill();
	}
	trackedProcessTrees.clear();
}

/** Start a cleanup command that outlives pi (detached) and whose failure is ignored. */
function spawnCleanup(command: string, args: string[]): void {
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
		// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
		child.once("error", () => {});
	} catch {
		// Ignore errors if the cleanup command cannot start.
	}
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		spawnCleanup(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), [
			"/F",
			"/T",
			"/PID",
			String(pid),
		]);
	} else {
		if (process.platform === "darwin") {
			// macOS signals group members individually after releasing the group lock. A killed
			// child can wake its waiting shell before that shell is signalled, letting `a; b`
			// start b during cancellation (#11252). Stop the group first to reduce this race;
			// this is best-effort, not an atomic freeze. SIGKILL also kills stopped processes.
			// Linux holds tasklist_lock across group signalling; child exit notification needs
			// its write lock, so the shell is signalled before observing the killed child's exit.
			try {
				process.kill(-pid, "SIGSTOP");
			} catch {
				// A failed stop must not prevent the kill attempt or its single-process fallback.
			}
		}
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
