import { spawn } from "child_process";

/**
 * Default timeout for search operations (grep, glob).
 * 30 seconds is generous for fd/rg which are extremely fast.
 * If they're taking this long, something is wrong (huge filesystem, catastrophic regex).
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

/**
 * Kill a process and all its children.
 * Uses platform-specific methods for reliable process tree termination.
 *
 * On Unix: Uses process group kill (SIGKILL to -pid)
 * On Windows: Uses taskkill /F /T
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
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
