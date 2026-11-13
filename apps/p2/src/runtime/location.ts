import { nul, obj, type Static, str, union } from "@earendil-works/pi-schema";
// Where a conversation works, shared by every process (no Node imports: the web and TUI bundles use it too).

export const LocationSchema = obj({ cwd: str(), env: union([str(), nul()]) });
/**
 * Where a conversation works: its cwd, on this machine (`env` null) or on a remote environment. The main conversation
 * works at the session's location; a subagent spawned with its own cwd at its own, on its caller's environment.
 */
export type Location = Static<typeof LocationSchema>;

export const sameLocation = (a: Location, b: Location): boolean => a.env === b.env && a.cwd === b.cwd;

/** A location as people read it: `gpu:/path` on a remote environment, the bare path on this machine. */
export const locationText = (location: Location): string =>
	location.env ? `${location.env}:${location.cwd}` : location.cwd;

/** Shows conventional macOS, Linux and Termux home directories as `~`. */
export function shortPath(path: string): string {
	return path.replace(/^\/(?:Users\/[^/]+|home\/[^/]+|root|data\/data\/com\.termux\/files\/home)(?=\/|$)/, "~");
}

/** `envs.ENV_NAME`: the names an environment may have. */
export const ENV_PREFIX = /^([a-z0-9][a-z0-9_-]{0,31}):(.*)$/s;
/** `local:` names this device, unless an environment is called "local". */
export const LOCAL = "local";

/** A location as typed: `[env:]path`, the path absolute, home-relative or relative (resolved by the receiver). */
export type LocationInput = { env: string | null; path: string };

/** Absolute (POSIX, Windows drive or UNC) or home-relative: the server resolves these itself. */
export function isRooted(path: string): boolean {
	return (
		path === "~" ||
		path.startsWith("~/") ||
		path.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(path) ||
		path.startsWith("\\\\")
	);
}

/** `base` joined with a relative `path`, `.` and `..` resolved, in `base`'s separator style. */
export function joinPath(base: string, path: string): string {
	const windows = /^[A-Za-z]:[\\/]/.test(base) || base.includes("\\");
	const separator = windows ? "\\" : "/";
	const root = windows ? (/^[A-Za-z]:/.exec(base)?.[0] ?? "") + separator : "/";
	const parts = base
		.slice(windows ? root.length : 0)
		.split(/[\\/]/)
		.filter(Boolean);
	for (const part of path.split(/[\\/]/)) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return root + parts.join(separator);
}

/**
 * Parses `[env:]path`. A configured environment's name selects it; `local:` is this device; any other prefix of a
 * name's form longer than one letter is an unknown environment (one letter is a Windows drive). Without a prefix the
 * location stays in `fallback.env`; a relative path joins `fallback.cwd` (`/cd sub`), else the home directory.
 */
export function parseLocation(
	text: string,
	envs: readonly string[],
	fallback: { env: string | null; cwd?: string },
): LocationInput | { error: string } {
	const input = text.trim();
	const match = ENV_PREFIX.exec(input);
	let env = fallback.env;
	let path = input;
	if (match && (envs.includes(match[1]!) || match[1] === LOCAL || match[1]!.length > 1)) {
		if (envs.includes(match[1]!)) env = match[1]!;
		else if (match[1] === LOCAL) env = null;
		else return { error: `Unknown environment "${match[1]}" (/envs lists them)` };
		path = match[2]!.trim();
	}
	if (!path) path = env === fallback.env && fallback.cwd ? fallback.cwd : "~";
	else if (!isRooted(path)) path = env === fallback.env && fallback.cwd ? joinPath(fallback.cwd, path) : `~/${path}`;
	return { env, path };
}
