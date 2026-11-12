// The server's name on disk and the device's name it falls back to.
//
// The name belongs to the server, not to Radius: `<data>/identity.json` (`{ "name": "Studio" }`) lives beside the
// sessions, works without Radius and survives `radius:login` and signing out (which rewrite or remove `radius.json`).
// The file exists only while the owner has named the server; without it the server is called by the device's name
// ("Cristina's MacBook Pro"), read again at every start, so renaming the device renames an unnamed server. Radius keeps
// a copy for its shell (plugins/radius/brain.ts, "Name"); the copy never flows back.
//
// The name is a label, never an identity or a credential: the Radius server ID stays the server's identity, and nothing
// authorizes by name. Places of projects name this machine by `os.hostname()`, not by this name.
import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_SERVER_NAME_LENGTH } from "./server-name.ts";

/** `name` as one trimmed line without control characters, at most MAX_SERVER_NAME_LENGTH characters; undefined if empty. */
export function normalizeServerName(name: string): string | undefined {
	const line = name
		.replace(/\p{Cc}|\p{Cf}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const clipped = Array.from(line).slice(0, MAX_SERVER_NAME_LENGTH).join("").trim();
	return clipped || undefined;
}

/**
 * The device's name, best effort: on macOS the computer name from System Settings ("Cristina’s MacBook Air"), else
 * the host name the operating system reports (`os.hostname()`), without the `.local` that macOS adds to it.
 * Undefined when neither gives one; the server then has no name and Radius shows its server ID.
 */
export async function deviceName(): Promise<string | undefined> {
	if (process.platform === "darwin") {
		try {
			const { stdout } = await promisify(execFile)("scutil", ["--get", "ComputerName"], { timeout: 2000 });
			const name = normalizeServerName(stdout);
			if (name) return name;
		} catch {
			// No computer name set (or no scutil): the host name below stands in.
		}
	}
	try {
		return normalizeServerName(hostname().replace(/\.local$/i, ""));
	} catch {
		// `uv_os_gethostname` can fail (restricted sandboxes): the server then has no name.
		return undefined;
	}
}

/**
 * The name the owner gave the server, or undefined when there is none (no `identity.json`). Throws for a file that
 * cannot be read or names nothing usable, saying why; the caller decides what stands in.
 */
export async function readChosenServerName(directory: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(identityPath(directory), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	// The owner's file (a trust boundary): hand edits may break it.
	const stored: unknown = JSON.parse(text);
	const name =
		stored !== null && typeof stored === "object" && "name" in stored && typeof stored.name === "string"
			? normalizeServerName(stored.name)
			: undefined;
	if (name === undefined) throw new Error("identity.json names nothing");
	return name;
}

/** Saves the owner's name for the server (atomically, private), or removes it for `undefined`. */
export async function writeChosenServerName(directory: string, name: string | undefined): Promise<void> {
	const path = identityPath(directory);
	if (name === undefined) {
		await rm(path, { force: true });
		return;
	}
	await writeFile(`${path}.tmp`, `${JSON.stringify({ name }, null, "\t")}\n`, { mode: 0o600 });
	await rename(`${path}.tmp`, path);
}

const identityPath = (directory: string) => join(directory, "identity.json");
