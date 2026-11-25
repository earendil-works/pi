// Copies a session's data to a new session ID (`Sessions.clone`, `Sessions.fork`; p2-tui-port.md section 10.8): a clone
// copies the whole session directory (`sessions/<id>/`: its store, copied while the session's worker is stopped so the
// SQLite file and its WAL belong together, and its files, whose immutable blobs are hard-linked), so the copy's
// attachments and downloads resolve under the new ID (plugins copy what they keep on the server through
// `SessionCopied`, e.g. artifacts). Nothing is overwritten; directories are 0700, files 0600, links skipped. A fork's
// files are copied by the source's worker (`SessionTransfer.copyFiles`), its history seeded into a fresh store.
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { sessionDirectory } from "@p2/app/v1/node";

const missing = (error: unknown): boolean =>
	error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT";

/**
 * Copies a private file or directory tree; a missing source is nothing to copy. Uploads under way (`.uploads`) are left
 * out; blobs (never changed) are hard-linked where the file system allows it.
 */
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
		for (const entry of await readdir(from))
			if (entry !== ".uploads") await privateCopy(join(from, entry), join(to, entry));
	} else if (stat.isFile() && from.includes(`${sep}blobs${sep}`)) {
		await link(from, to).catch(() => copyFile(from, to, constants.COPYFILE_EXCL));
	} else if (stat.isFile()) {
		await copyFile(from, to, constants.COPYFILE_EXCL);
		await chmod(to, 0o600);
	}
}

/** The session's directory (its store with its WAL, its files); call only while no worker has it open. */
export async function copySessionDirectory(dataDir: string, from: string, to: string): Promise<void> {
	await mkdir(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
	await privateCopy(sessionDirectory(dataDir, from), sessionDirectory(dataDir, to));
}

/** Removes what a failed copy left for the session `id` (its row is archived, its worker stopped). */
export async function removeSessionCopy(dataDir: string, id: string): Promise<void> {
	await Promise.all([
		rm(sessionDirectory(dataDir, id), { recursive: true, force: true }),
		// Its attachments materialized on this machine, if any.
		rm(join(dataDir, "uploads", id), { recursive: true, force: true }),
	]);
}
