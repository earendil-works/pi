// The machine type of this device (`local`, decision 117: the family's first type): the machine the server runs on,
// with no settings. Its host is Node's environment here with Pi's data folder hidden, a folder's names in one read,
// and an upload's file staged beside its target (only the server's user may read it, its name its own, known by its
// device, inode and birth time, so a sweep leaves a file that replaced it before the check); its terminals are pending
// a decision (pi-env's daemon, node-pty or a helper).

import { randomBytes } from "node:crypto";
import { type FileHandle, lstat, open, opendir, readdir, readlink, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { type Context, contribute, type FacetHost, obj, type P3Principal } from "@earendil-works/p3/v1";
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
		listNames: (folder, max, context) => attempt(() => namesIn(folder, max, context)),
		stageFile: (folder) => attempt(() => staged(folder)),
		removeStaged: (path, identity) => attempt(() => removedIf(path, identity)),
		openPty: async () => ({ ok: false, error: new FileError("not_supported", "this device has no terminals yet") }),
		close: async () => {},
	};
}

/**
 * `folder`'s first `max` names and kinds, read without their entries, and whether it has more. All of them in one
 * read (a page of a folder sorts them all); a bounded read a name at a time, so it holds no more of a large folder
 * than its bound (each name costs a wait: about 7 µs), and stops when `context` aborts.
 */
async function namesIn(folder: string, max: number, context: Context): Promise<{ names: NameEntry[]; more: boolean }> {
	if (max === Number.POSITIVE_INFINITY) {
		return { names: (await readdir(folder, { withFileTypes: true })).map(nameOf), more: false };
	}
	const names: NameEntry[] = [];
	// Leaving the loop closes the folder.
	for await (const entry of await opendir(folder, { bufferSize: 1024 })) {
		context.abortSignal?.throwIfAborted();
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
		let file: FileHandle;
		try {
			file = await open(path, "wx", 0o600);
		} catch (error) {
			if (tries === STAGE_TRIES || codeOf(error) !== "EEXIST") throw error;
			continue;
		}
		try {
			return stagedAt(path, identityOf(await file.stat({ bigint: true })), file);
		} catch (error) {
			// Ours, but not known by its identity: closed, and the empty file left (removing it by name would be a
			// guess).
			await file.close().catch(() => undefined);
			throw error;
		}
	}
}

/**
 * The staged file `file`, made at `path` with `identity`. Its publish and its discard have one owner: whichever is
 * called first settles it, and a discard called after a publish waits for it and removes nothing that landed.
 */
function stagedAt(path: string, identity: string, file: FileHandle): StagedFile {
	let landing: Promise<Result<void, FileError>> | undefined;
	let removal: Promise<Result<"removed" | "landed", FileError>> | undefined;
	// Closed once, by whichever settles it: where it was then.
	let shut: Promise<string> | undefined;
	const closed = () => {
		shut ??= closing(path, file);
		return shut;
	};
	return {
		path,
		identity,
		write: (bytes, context) =>
			attempt(async () => {
				for (let at = 0; at < bytes.length; ) {
					context.abortSignal?.throwIfAborted();
					at += (await file.write(bytes, at, bytes.length - at)).bytesWritten;
				}
			}),
		publish: (target) => {
			if (landing !== undefined || removal !== undefined) {
				return Promise.resolve({ ok: false, error: new FileError("invalid", "the staged file was settled") });
			}
			landing = attempt(async () => {
				await file.chmod(await modeFor(target));
				await rename(await closed(), target);
			});
			return landing;
		},
		discard: () => {
			removal ??= (async () => {
				const landed = landing === undefined ? undefined : await landing;
				if (landed?.ok === true) return { ok: true, value: "landed" as const };
				return attempt(async () => {
					if ((await removedIf(await closed(), identity)) === "absent") throw gone(path);
					return "removed" as const;
				});
			})();
			return removal;
		},
	};
}

/** Where the open `file` (made at `path`) is now, closed: closed also when it is no longer found. */
async function closing(path: string, file: FileHandle): Promise<string> {
	try {
		return await whereNow(path, file);
	} finally {
		await file.close();
	}
}

/**
 * Removes the staged file at `path` if it is the one with `identity` when checked; `absent` when another file or none
 * is there (also when a removal of the same file came first). The check and the removal are two steps: a file that
 * replaces it in between is removed, a residual race only someone who can change the machine's files has
 * (ERNDL-1173).
 */
async function removedIf(path: string, identity: string): Promise<"removed" | "absent"> {
	const found = await lstat(path, { bigint: true }).catch((error: unknown) => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (found === undefined || !found.isFile() || identityOf(found) !== identity) return "absent";
	try {
		await unlink(path);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return "absent";
		throw error;
	}
	return "removed";
}

/**
 * A file's identity on this machine: its device, inode and birth time. An inode is reused once its file went; a file
 * at the same random path with the inode and the birth time (the file system's clock tick) of a staged file is the
 * residual chance.
 */
function identityOf(stats: { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint }): string {
	return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

/** The refusal of a staged file that is no longer found. */
function gone(path: string): FileError {
	return new FileError("not_found", `the staged file made at ${path} is no longer found`, path);
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
	throw gone(path);
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
