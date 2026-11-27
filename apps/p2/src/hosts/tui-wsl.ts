// WSL detection for the launcher, copied from coding-agent utils/wsl.ts so p2 and pi agree on key defaults and
// clipboard paths.
import { readFileSync } from "node:fs";

/**
 * Whether this process runs inside Windows Subsystem for Linux. The WSL variables are only set in shells started
 * through `wsl.exe`; processes started by a systemd service lack them, so the kernel release is the fallback.
 */
export function isWSL(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
	if (platform !== "linux") return false;
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}
