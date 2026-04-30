/**
 * Workaround for https://github.com/oven-sh/bun/issues/27802
 *
 * Bun compiled binaries have an empty `process.env` when running inside
 * sandbox environments (e.g. nono on Linux/macOS). On Linux we can recover
 * the environment from `/proc/self/environ`.
 */

import { readFileSync } from "node:fs";

/**
 * Restore environment variables from `/proc/self/environ` when running
 * inside a sandbox where Bun's `process.env` is empty.
 */
export function restoreSandboxEnv(): void {
	if (!process.versions?.bun) return;

	// If process.env already has entries, nothing to fix.
	if (Object.keys(process.env).length > 0) return;

	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
	} catch {
		// /proc/self/environ may not be readable; ignore.
	}
}
