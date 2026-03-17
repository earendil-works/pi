/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.js";

interface CacheEntry {
	value: string | undefined;
	timestamp: number;
}

// Cache for shell command results (supports optional TTL)
const commandResultCache = new Map<string, CacheEntry>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 * @param cacheTtlSeconds Optional TTL in seconds for shell command cache entries.
 *   When set, cached results expire after this duration and the command is re-executed.
 *   When unset, results are cached for the process lifetime.
 */
export function resolveConfigValue(config: string, cacheTtlSeconds?: number): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config, cacheTtlSeconds);
	}
	const envValue = process.env[config];
	return envValue || config;
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		const result = spawnSync(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommand(commandConfig: string, cacheTtlSeconds?: number): string | undefined {
	const cached = commandResultCache.get(commandConfig);
	if (cached) {
		// Check if cache entry is still valid
		if (cacheTtlSeconds === undefined || Date.now() - cached.timestamp < cacheTtlSeconds * 1000) {
			return cached.value;
		}
		// TTL expired — fall through to re-execute
	}

	const command = commandConfig.slice(1);
	const result =
		process.platform === "win32"
			? (() => {
					const configuredResult = executeWithConfiguredShell(command);
					return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
				})()
			: executeWithDefaultShell(command);

	commandResultCache.set(commandConfig, { value: result, timestamp: Date.now() });
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	cacheTtlSeconds?: number,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, cacheTtlSeconds);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
