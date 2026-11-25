// Vitest global setup: builds the daemon the tests run, so they never run a stale build after its source changed.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Builds ../daemon with cargo (about two seconds when it is up to date), unless `PI_ENV_DAEMON` names a built one. */
export default function setup(): void {
	if (process.env.PI_ENV_DAEMON !== undefined) return;
	const manifest = resolve(import.meta.dirname, "../daemon/Cargo.toml");
	try {
		execFileSync("cargo", ["build", "--manifest-path", manifest, "--locked"], { stdio: "inherit" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("The pi-env tests build the daemon with cargo, which is not installed: see https://rustup.rs");
		}
		throw error;
	}
}
