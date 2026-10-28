import { readFileSync } from "node:fs";

/** Windows Subsystem for Linux, where Windows executables are reachable through interop. */
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
