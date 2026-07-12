import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR_NAME = ".pi";
const ENV_ORCHESTRATOR_DIR = "PI_ORCHESTRATOR_DIR";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

interface PackageJson {
	version?: string;
}

function getPackageJsonPath(): string {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		const packageJsonPath = join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			return packageJsonPath;
		}
		dir = dirname(dir);
	}
	return join(__dirname, "package.json");
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

export const VERSION: string = pkg.version || "0.0.0";

export function getOrchestratorDir(): string {
	const envDir = process.env[ENV_ORCHESTRATOR_DIR];
	if (envDir) {
		return envDir;
	}

	const piDir = process.env.PI_CONFIG_DIR || join(homedir(), CONFIG_DIR_NAME);
	return join(piDir, "orchestrator");
}

export function getAuthPath(): string {
	return join(getOrchestratorDir(), "auth.json");
}

export function getMachinePath(): string {
	return join(getOrchestratorDir(), "machine.json");
}

export function getInstancesPath(): string {
	return join(getOrchestratorDir(), "instances.json");
}

export function getSocketPath(): string {
	return join(getOrchestratorDir(), "orchestrator.sock");
}
