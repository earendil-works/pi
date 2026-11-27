// Builds this machine's pi-env daemon from the checkout (`packages/env/daemon`, `cargo build --release --locked`): what
// this device's terminals run in in a source checkout (`terminalDaemon` finds this build first; an install gets the
// one pi-env's package ships). `npm test` runs it first (`pretest`), so does p3-base's deploy; cargo's build is
// incremental, about 1 s when nothing changed. A machine without Rust fails here, saying what to install.
// Run: npm run build:daemon (in apps/p3)

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The daemon's Cargo manifest in the checkout. */
const MANIFEST = fileURLToPath(new URL("../../../packages/env/daemon/Cargo.toml", import.meta.url));

/** Where cargo is: on the `PATH`, else where rustup installs it (a non-login shell's `PATH` lacks it). */
const CARGO = ["cargo", join(homedir(), ".cargo", "bin", "cargo")].find((candidate) => {
	try {
		execFileSync(candidate, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
});

if (CARGO === undefined) {
	console.error(
		"build:daemon: cargo was not found (on the PATH or in ~/.cargo/bin). This device's terminals run in pi-env's " +
			"daemon, built from the checkout: install Rust (https://rustup.rs), then run `npm run build:daemon` in apps/p3.",
	);
	process.exit(1);
}
// Into the checkout's `daemon/target`, where `terminalDaemon` looks, whatever `CARGO_TARGET_DIR` says.
const TARGET = join(dirname(MANIFEST), "target");
execFileSync(
	CARGO,
	["build", "--release", "--locked", "--quiet", "--manifest-path", MANIFEST, "--target-dir", TARGET],
	{
		stdio: "inherit",
	},
);
