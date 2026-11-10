// Compact directory and environment labels for the web UI; the underlying paths stay unchanged.
import { shortPath } from "../runtime/location.ts";

// Every process shortens paths alike (project glyphs hash the short form), so the rule lives in the runtime.
export { shortPath };

/** Where a session's tools run: a compact path, prefixed by its remote environment when present. */
export function locationLabel(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${shortPath(cwd)}` : shortPath(cwd);
}
