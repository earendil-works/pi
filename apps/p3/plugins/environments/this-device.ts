// The machine type of this device (`local`, decision 117: the family's first type): the machine the server runs on,
// with no settings. Its host is Node's environment here with Pi's data folder hidden, a folder's names in one read,
// and an upload's file staged beside its target (only the server's user may read it, its name its own); its terminals
// are pending a decision (pi-env's daemon, node-pty or a helper).

import { randomBytes } from "node:crypto";
import { type FileHandle, lstat, open, opendir, readdir, readlink, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { contribute, type FacetHost, obj, type P3Principal } from "@earendil-works/p3/v1";
import { FileError, NodeExecutionEnv, type Result, ServerRuntime } from "@earendil-works/p3/v1/server";
import {
	type MachineHost,
	type MachineType,
	MachineTypes,
	type NameEntry,
	type StagedFile,
} from "./contract.server.ts";
import { MACHINE_KIND } from "./contract.ts";
import { messages } from "./messages.ts";

/** The type's name: what this device's machine stores (its seeded thing, which has no row, is of it). */
export const THIS_DEVICE_TYPE = "local";

/** This device's machine: the machine kind's one thing (`OneThing`'s params). */
export const THIS_DEVICE = { kind: MACHINE_KIND };

/** Contributes this device's machine type on `host`, its data folder hidden. */
export function serveThisDevice(host: FacetHost<P3Principal>): void {
	contribute(host, "environments.this-device-type", (self) => {
		const { dataDir } = self.registry(ServerRuntime).value;
		const type: MachineType = {
			type: THIS_DEVICE_TYPE,
			label: messages.message("thisDevice"),
			settings: obj({}),
			connect: async () => thisDevice(dataDir),
		};
		self.contribute(MachineTypes, type);
	});
}

/** This device's host: one per connection, nothing to close. */
function thisDevice(dataDir: string): MachineHost {
	return {
		env: new NodeExecutionEnv({ cwd: homedir() }),
		hidden: [dataDir],
		listNames: (folder, max) => attempt(() => namesIn(folder, max)),
		stageFile: (folder) => attempt(() => staged(folder)),
		openPty: async () => ({ ok: false, error: new FileError("not_supported", "this device has no terminals yet") }),
		close: async () => {},
	};
}

/**
 * `folder`'s first `max` names and kinds, read without their entries, and whether it has more. All of them in one
 * read (a page of a folder sorts them all); a bounded read a name at a time, so it holds no more of a large folder
 * than its bound (each name costs a wait: about 7 µs).
 */
async function namesIn(folder: string, max: number): Promise<{ names: NameEntry[]; more: boolean }> {
	if (max === Number.POSITIVE_INFINITY) {
		return { names: (await readdir(folder, { withFileTypes: true })).map(nameOf), more: false };
	}
	const names: NameEntry[] = [];
	// Leaving the loop closes the folder.
	for await (const entry of await opendir(folder, { bufferSize: 1024 })) {
		if (names.length === max) return { names, more: true };
		names.push(nameOf(entry));
	}
	return { names, more: false };
}

/** A folder entry's name and kind (a socket or a device counts as a file). */
function nameOf(entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): NameEntry {
	return { name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file" };
}

/** How many names a staged file tries when one is taken. */
const STAGE_TRIES = 4;

/**
 * A staged file in `folder`: `.p3-upload-<12 hex>`, created exclusively (`wx`: never through a link) and `0600`, so
 * nobody else reads it while it is written; a name that exists already is tried again with another.
 */
async function staged(folder: string): Promise<StagedFile> {
	for (let tries = 1; ; tries++) {
		const path = `${folder === "/" ? "" : folder}/.p3-upload-${randomBytes(6).toString("hex")}`;
		try {
			return stagedAt(path, await open(path, "wx", 0o600));
		} catch (error) {
			if (tries === STAGE_TRIES || codeOf(error) !== "EEXIST") throw error;
		}
	}
}

/** The staged file `file`, made at `path`. */
function stagedAt(path: string, file: FileHandle): StagedFile {
	// Where it was last found, and whether it is still open (a publish that failed after the close left it there).
	let where = path;
	let open = true;
	const closed = async () => {
		if (!open) return where;
		open = false;
		try {
			where = await whereNow(path, file);
		} finally {
			await file.close();
		}
		return where;
	};
	return {
		path,
		write: (bytes) =>
			attempt(async () => {
				for (let at = 0; at < bytes.length; ) at += (await file.write(bytes, at, bytes.length - at)).bytesWritten;
			}),
		publish: (target) =>
			attempt(async () => {
				await file.chmod(await modeFor(target));
				await rename(await closed(), target);
			}),
		discard: () => attempt(async () => unlink(await closed())),
	};
}

/**
 * The permission bits a file landing at `target` gets: those of the regular file it replaces, without setuid, setgid
 * and sticky; else a new file's ordinary ones (`0666` less the umask). Never broader than those.
 */
async function modeFor(target: string): Promise<number> {
	const replaced = await lstat(target).catch((error: unknown) => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (replaced?.isFile() === true) return replaced.mode & 0o777;
	return 0o666 & ~process.umask();
}

/**
 * Where the open file `file`, made at `path`, is now: its folder may have moved since. Linux and Android name an open
 * file's path in `/proc/self/fd`; elsewhere it is `path`. Either is used only while it is still that file (the same
 * device and inode).
 */
async function whereNow(path: string, file: FileHandle): Promise<string> {
	const own = await file.stat();
	const named = await readlink(`/proc/self/fd/${file.fd}`).catch(() => undefined);
	for (const candidate of named === undefined ? [path] : [named, path]) {
		const found = await lstat(candidate).catch(() => undefined);
		if (found !== undefined && found.dev === own.dev && found.ino === own.ino) return candidate;
	}
	throw new FileError("not_found", `the staged file made at ${path} is no longer found`, path);
}

/** `fn`'s value, or what it threw as a `FileError` (a trust boundary: Node's errors carry their code). */
async function attempt<T>(fn: () => Promise<T>): Promise<Result<T, FileError>> {
	try {
		return { ok: true, value: await fn() };
	} catch (error) {
		return { ok: false, error: fileError(error) };
	}
}

/** A thrown error as a `FileError`, by its Node code. */
function fileError(error: unknown): FileError {
	if (error instanceof FileError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const code = codeOf(error);
	return new FileError(CODES[code ?? ""] ?? "unknown", message);
}

/** Node's error codes as `FileError`'s. */
const CODES: Readonly<Record<string, FileError["code"]>> = {
	ENOENT: "not_found",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	ENOTDIR: "not_directory",
	EISDIR: "is_directory",
	EINVAL: "invalid",
	EEXIST: "invalid",
	ABORT_ERR: "aborted",
};

/** The code of a thrown Node error, if it has one. */
function codeOf(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
