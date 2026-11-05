// Copies a session's files to a new session ID (`Sessions.clone`, `Sessions.fork`; p2-tui-port.md section 10.8): the
// Durable store, copied while the session's worker is stopped (its SQLite files closed, so the main file and its WAL
// belong together), and the private per-session directories of artifacts, downloads and uploads, so the copies' cards
// and attachments resolve under the new ID. Nothing is overwritten; directories are 0700, files 0600, links skipped.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const missing = (error: unknown): boolean =>
	error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT";

/** Copies a private file or directory tree; a missing source is nothing to copy. */
async function privateCopy(from: string, to: string): Promise<void> {
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(from);
	} catch (error) {
		if (missing(error)) return;
		throw error;
	}
	if (stat.isDirectory()) {
		await mkdir(to, { mode: 0o700 });
		for (const entry of await readdir(from)) await privateCopy(join(from, entry), join(to, entry));
	} else if (stat.isFile()) {
		await copyFile(from, to, constants.COPYFILE_EXCL);
		await chmod(to, 0o600);
	}
}

/** The per-session directories under the data directory (artifacts, downloads, uploads). */
export async function copySessionDirectories(dataDir: string, from: string, to: string): Promise<void> {
	for (const kind of ["artifacts", "downloads", "uploads"]) {
		const source = join(dataDir, kind, from);
		try {
			await lstat(source);
		} catch (error) {
			if (missing(error)) continue;
			throw error;
		}
		await mkdir(join(dataDir, kind), { recursive: true, mode: 0o700 });
		await privateCopy(source, join(dataDir, kind, to));
	}
}

/** The session's Durable store with its WAL; call only while no worker has it open. */
export async function copySessionStore(dataDir: string, from: string, to: string): Promise<void> {
	await mkdir(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
	for (const suffix of ["", "-wal", "-shm"])
		await privateCopy(
			join(dataDir, "sessions", `${from}.sqlite${suffix}`),
			join(dataDir, "sessions", `${to}.sqlite${suffix}`),
		);
}

/** Removes the copy's per-session directories (a fork starting its copy over). */
export async function removeSessionDirectories(dataDir: string, id: string): Promise<void> {
	await Promise.all(
		["artifacts", "downloads", "uploads"].map((kind) =>
			rm(join(dataDir, kind, id), { recursive: true, force: true }),
		),
	);
}

/** Removes what a failed copy left for the session `id` (its row is archived, its worker stopped). */
export async function removeSessionCopy(dataDir: string, id: string): Promise<void> {
	await Promise.all([
		...["", "-wal", "-shm"].map((suffix) => rm(join(dataDir, "sessions", `${id}.sqlite${suffix}`), { force: true })),
		removeSessionDirectories(dataDir, id),
	]);
}
