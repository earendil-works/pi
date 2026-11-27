// This machine's pi-env daemon (`packages/env`), for the machine types' server facets: a program of its own that runs
// pseudo-terminals, so their output is read off the server's thread. It is the binary pi-env's package ships for this
// system (its `bin/`, which a release installs), else a build in its source checkout (`daemon/target`, `cargo build
// --release` for a release target or the native one). Found through the package's own location: pi-env's
// `localDaemon` looks beside its module, which in p3's bundled server is p3's.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Rust targets of pi-env's release builds, by system (`.github/workflows/env-daemons.yml`). */
const TARGETS: Readonly<Record<string, string>> = {
	"linux-x64": "x86_64-unknown-linux-musl",
	"linux-arm64": "aarch64-unknown-linux-musl",
	"android-x64": "x86_64-linux-android",
	"android-arm64": "aarch64-linux-android",
	"darwin-x64": "x86_64-apple-darwin",
	"darwin-arm64": "aarch64-apple-darwin",
};

/** The path of this machine's pi-env daemon; refused, naming where it looked, when there is none. */
export async function terminalDaemon(): Promise<string> {
	const system = `${process.platform}-${process.arch}`;
	const root = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-env")));
	const target = TARGETS[system];
	const candidates = [
		join(root, "bin", `pi-env-${system}`, "pi-env"),
		...(target === undefined ? [] : [join(root, "daemon", "target", target, "release", "pi-env")]),
		join(root, "daemon", "target", "release", "pi-env"),
	];
	for (const candidate of candidates) {
		if (
			await access(candidate, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return candidate;
	}
	throw new Error(`no pi-env daemon for ${system} (looked at ${candidates.join(", ")})`);
}
