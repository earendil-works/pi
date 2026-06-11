import { readFileSync } from "fs";

/**
 * Detect whether the current process is running under Windows Subsystem for Linux.
 *
 * Checks the WSL-specific environment variables first, then falls back to the
 * kernel release string in `/proc/version`.
 */
export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}
