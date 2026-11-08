// Compact directory and environment labels for the web UI; the underlying paths stay unchanged.

/** Shows conventional macOS, Linux and Termux home directories as `~`. */
export function shortPath(path: string): string {
	return path.replace(/^\/(?:Users\/[^/]+|home\/[^/]+|root|data\/data\/com\.termux\/files\/home)(?=\/|$)/, "~");
}

/** Where a session's tools run: a compact path, prefixed by its remote environment when present. */
export function locationLabel(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${shortPath(cwd)}` : shortPath(cwd);
}
