import { readFileSync } from "node:fs";
import { release } from "node:os";

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

/**
 * WSL2, detected from the kernel release: WSL2 runs Microsoft's Linux kernel (`5.15.167.4-microsoft-standard-WSL2`),
 * while WSL1 reports an emulated release such as `4.4.0-19041-Microsoft`.
 */
export function isWSL2(platform: NodeJS.Platform = process.platform, kernelRelease: string = release()): boolean {
	return platform === "linux" && /microsoft-standard|wsl2/i.test(kernelRelease);
}
