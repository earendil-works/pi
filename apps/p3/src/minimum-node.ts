// The oldest Node p3 runs on, checked before anything else: `src/bootstrap/bin.ts` imports this module first, so a
// Node too old for p3 (or for a flag its workers start with) gets one clear line and exit 1, not a failure deep in a
// module. A session worker never starts alone: only a server forks it, with the server's Node.

/** The oldest Node p3 runs on: `engines.node` in its `package.json`. */
export const MINIMUM_NODE = "24.4.0";

/** Whether Node `version` (`process.versions.node`, as `24.4.1`) is older than `MINIMUM_NODE`. */
export function tooOld(version: string): boolean {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	const [minMajor = 0, minMinor = 0, minPatch = 0] = MINIMUM_NODE.split(".").map(Number);
	return major !== minMajor ? major < minMajor : minor !== minMinor ? minor < minMinor : patch < minPatch;
}

if (tooOld(process.versions.node)) {
	console.error(`p3: needs Node ${MINIMUM_NODE} or newer; this is Node ${process.versions.node}`);
	process.exit(1);
}
