// This machine's pi-env daemon (`packages/env`), for the machine types' server facets: a program of its own that runs
// pseudo-terminals, so their output is read off the server's thread. In a source checkout it is the checkout's build
// (`npm run build:daemon` in apps/p3, which `npm test` runs first: `daemon/target/release`); in an install, the binary
// pi-env's package ships for this system (its `bin/`). Found through the package's own location: pi-env's
// `localDaemon` looks beside its module, which in p3's bundled server is p3's.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The path of this machine's pi-env daemon; refused, naming where it looked and how to build it, if none. */
export async function terminalDaemon(): Promise<string> {
	const system = `${process.platform}-${process.arch}`;
	const root = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-env")));
	const candidates = [
		join(root, "daemon", "target", "release", "pi-env"),
		join(root, "bin", `pi-env-${system}`, "pi-env"),
	];
	for (const candidate of candidates) {
		if (await access(candidate, constants.X_OK).then(isThere, isNotThere)) return candidate;
	}
	const looked = candidates.join(", ");
	throw new Error(
		`no pi-env daemon for ${system} (looked at ${looked}): in a checkout, run \`npm run build:daemon\` in apps/p3`,
	);
}

/** An `access` that passed. */
const isThere = () => true;

/** An `access` that failed: no such file, or not executable. */
const isNotThere = () => false;
