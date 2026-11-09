// The brain's name: what this p2 calls itself, in `<data>/identity.json`.
//
// The name belongs to the brain, not to Radius: it lives in the data directory beside the sessions, works without
// Radius, and survives `radius:login` and signing out (which rewrite or remove `radius.json`). The first read creates
// it with the device's name ("Cristina's MacBook Pro"), so a brain usually has one without asking; when the device
// has no usable name, the brain has none and Radius shows its server ID. The brain reports
// it to Radius on every host connect (`?name=`, see brain.ts), and Radius records it on the claim, so a rename here
// reaches Radius with the next reconnect; nothing is pushed from Radius. Two brains on one machine start with the same
// name; rename one by editing the file.
//
// The name is a label, never an identity or a credential: the server ID stays the brain's identity, and nothing
// authorizes by name.
import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export type BrainIdentity = { name: string };

/**
 * Longest name, in characters, as Radius stores (`MAX_SERVER_NAME_LENGTH`): a DNS label (63), so a host name is never
 * cut. Linux 64, Windows 15, Kubernetes and cloud VMs 63; only a macOS computer name can be longer.
 */
const MAX_NAME_LENGTH = 63;

export function brainIdentityPath(directory: string): string {
	return join(directory, "identity.json");
}

/** `name` as one trimmed line without control characters, at most MAX_NAME_LENGTH characters; undefined if empty. */
export function normalizeBrainName(name: unknown): string | undefined {
	if (typeof name !== "string") return undefined;
	const line = name
		.replace(/\p{Cc}|\p{Cf}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const clipped = Array.from(line).slice(0, MAX_NAME_LENGTH).join("").trim();
	return clipped || undefined;
}

/**
 * The device's name, best effort: on macOS the computer name from System Settings ("Cristina’s MacBook Air"), else
 * the host name the operating system reports (`os.hostname()`), without the `.local` that macOS adds to it.
 * Undefined when neither gives one; the brain then has no name and Radius shows its server ID.
 */
export async function deviceName(): Promise<string | undefined> {
	if (process.platform === "darwin") {
		try {
			const { stdout } = await promisify(execFile)("scutil", ["--get", "ComputerName"], { timeout: 2000 });
			const name = normalizeBrainName(stdout);
			if (name) return name;
		} catch {}
	}
	try {
		return normalizeBrainName(hostname().replace(/\.local$/i, ""));
	} catch {
		return undefined;
	}
}

/**
 * The brain's identity, created with the device's name when absent. A file that is not JSON or names nothing usable
 * is replaced the same way, so a broken edit falls back to the device name instead of an unnamed brain.
 *
 * Best effort, never throws: the name is a label, and a data directory the brain cannot read or write it in (a
 * read-only or locked-down sandbox, `identity.json` a directory) must not keep the brain offline. Then the device's
 * name stands in for this read without being saved, and a file that exists but cannot be read is left alone.
 * Undefined when there is no name at all (no usable file and no device name): nothing is saved, so a later read tries
 * the device again.
 */
export async function readBrainIdentity(directory: string): Promise<BrainIdentity | undefined> {
	const path = brainIdentityPath(directory);
	let text: string | undefined;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return named(await deviceName());
	}
	let stored: unknown;
	try {
		stored = text === undefined ? undefined : JSON.parse(text);
	} catch {}
	const name = normalizeBrainName((stored as { name?: unknown } | null | undefined)?.name);
	if (name) return { name };
	const identity = named(await deviceName());
	if (identity) await writeBrainIdentity(directory, identity).catch(() => {});
	return identity;
}

const named = (name: string | undefined): BrainIdentity | undefined => (name === undefined ? undefined : { name });

export async function writeBrainIdentity(directory: string, identity: BrainIdentity): Promise<void> {
	const path = brainIdentityPath(directory);
	await writeFile(`${path}.tmp`, `${JSON.stringify(identity, null, "\t")}\n`, { mode: 0o600 });
	await rename(`${path}.tmp`, path);
}
