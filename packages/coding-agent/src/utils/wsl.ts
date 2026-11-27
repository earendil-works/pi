import { readFileSync } from "node:fs";

/**
 * Whether this process runs inside Windows Subsystem for Linux.
 *
 * The WSL variables are only set in shells started through `wsl.exe`. Processes started by a systemd service
 * (for example a terminal running as a user service) lack them, so the kernel release is the fallback.
 */
export function isWSL(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
	if (platform !== "linux") {
		return false;
	}

	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}
