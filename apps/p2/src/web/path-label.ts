// Compact directory and environment labels for the web UI; the underlying paths stay unchanged.
import { shortPath } from "../runtime/location.ts";

// The runtime's rule, so every process shortens paths alike.
export { shortPath };

/** Where a session's tools run: a compact path, prefixed by its remote environment when present. */
export function locationLabel(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${shortPath(cwd)}` : shortPath(cwd);
}
