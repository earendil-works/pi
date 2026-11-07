import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runOpenCodeProcess } from "./process.ts";

export const cliVersions = new Map<string, string | undefined>();

export async function usesV2Cli(): Promise<boolean> {
	if (!cliVersions.has(opencodeBin())) await checkCliStatus();
	return cliVersions.get(opencodeBin())?.startsWith("2.") === true;
}

const DISCOVERY_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 10_000;

type CliStatus = {
	ok: boolean;
	summary: string;
	detail?: string;
};

export function opencodeBin(): string {
	const configured = process.env.OPENCODE_PI_BIN?.trim();
	if (configured) {
		return configured.includes("/") || configured.includes("\\") ? resolve(configured) : configured;
	}
	if (process.platform === "win32") {
		// npm's `opencode.cmd` shim cannot be launched by spawn() without a shell.
		// Resolve the native executable installed beside the active Node runtime.
		const native = join(dirname(process.execPath), "node_modules", "opencode-ai", "bin", "opencode.exe");
		if (existsSync(native)) return native;
	}
	return "opencode";
}

export function runCapture(
	args: string[],
	input?: string,
	timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return runOpenCodeProcess(opencodeBin(), args, {
		input,
		timeoutMs,
		env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
	});
}

/** Build the install/setup instructions shown when the opencode CLI is unusable. */
export function setupGuidance(error: string): string {
	return [
		"pi-opencode-cli-bridge could not use the local OpenCode CLI.",
		`Reason: ${error}`,
		"Install OpenCode (https://opencode.ai), ensure `opencode --version` works on PATH, then reload Pi.",
		"Set OPENCODE_PI_BIN to override the executable path.",
	].join(" ");
}

/** Probe the OpenCode CLI with `opencode --version` to detect a missing/broken install. */
export async function checkCliStatus(): Promise<CliStatus> {
	try {
		const result = await runCapture(["--version"], undefined, STATUS_TIMEOUT_MS);
		if (result.code !== 0) {
			const detail =
				result.stderr.trim() || result.stdout.trim() || `opencode --version exited with code ${result.code}`;
			return { ok: false, summary: "OpenCode CLI is unusable", detail };
		}
		const version = result.stdout.trim() || result.stderr.trim() || "OpenCode CLI is available";
		cliVersions.set(opencodeBin(), /\d+\.\d+\.\d+/.exec(version)?.[0]);
		return { ok: true, summary: version };
	} catch (error) {
		return {
			ok: false,
			summary: "OpenCode CLI is unavailable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
