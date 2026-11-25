// Copying a host's files (decision "Files v2"): one host's `Files` (its index and its blobs) into a new host
// directory, for an app that makes a new address from an existing one (p2's clone and fork). The index is the part of
// the source store's export that is `Files`' own (its tables and documents), imported as the new directory's store;
// each blob is linked (blobs never change, so two hosts may share the file) or copied while the export holds the
// source's commit queue, so no removal can take a blob the copied index still names.

import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { type ArchivePart, importStore, type Store, sqliteBackend } from "../../store/index.ts";
import { Blobs } from "./blobs.ts";
import { Files } from "./files.ts";
import { privateDirectory, privateStore } from "./layout.ts";

/**
 * Copies the files of the host whose open store is `source.store` and whose files directory is `source.files` into
 * the new host directory `target` (refused when it exists): `target/store.sqlite` holding only the `Files` index,
 * `target/files/blobs/` its blobs. Staged beside `target` and renamed into place, so a failed copy leaves nothing.
 * Runs where the source store is open (its worker, or whoever holds its lock); the source may go on meanwhile.
 */
export async function copyFiles(
	source: { readonly store: Store; readonly files: string },
	target: string,
	context: Context,
): Promise<void> {
	if (await exists(target)) throw new Error(`copyFiles: ${target} exists already`);
	await privateDirectory(dirname(target));
	const staging = await mkdtemp(join(dirname(target), ".chord-files-copy-"));
	try {
		const blobs = new Blobs(join(source.files, "blobs"));
		const into = join(staging, "files", "blobs");
		await mkdir(into, { recursive: true, mode: 0o700 });
		await privateStore(join(staging, "store.sqlite"));
		const backend = sqliteBackend(await openNodeSqliteDatabase(join(staging, "store.sqlite")));
		const store = await importStore(backend, filesParts(source.store, blobs, into, context), context);
		await store.close(context);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

/** Who owns `Files`' tables (`<owner>:<table>`) and documents in a store: its contract. */
const OWNER = Files.name;

/**
 * The parts of `store`'s export that are `Files`' own: the manifest, its tables' parts, its documents' parts, and an
 * `end` counting them. Each blob row's file is put into `into` before its part is passed on.
 */
async function* filesParts(store: Store, blobs: Blobs, into: string, context: Context): AsyncGenerator<ArchivePart> {
	const documents = new Set<number>();
	let writes = 0;
	for await (const part of store.export(context)) {
		const kept = keeps(part, documents);
		if (part.kind === "end") yield { kind: "end", writes };
		if (!kept) continue;
		if (part.kind === "put" && part.table === `${OWNER}:blobs`) {
			// A blob row's key: the kit's own column, a string.
			await blobs.linkInto(part.row.id as string, into);
		}
		if (part.kind !== "manifest") writes++;
		yield part;
	}
}

/** Whether `part` belongs to `Files` (the manifest does too); its documents' ids are remembered in `documents`. */
function keeps(part: ArchivePart, documents: Set<number>): boolean {
	switch (part.kind) {
		case "manifest":
			return true;
		case "table":
		case "put":
		case "index":
			return part.table.startsWith(`${OWNER}:`);
		case "document.create":
			if (part.record.owner === OWNER) documents.add(part.record.id);
			return part.record.owner === OWNER;
		case "document.revision":
			return documents.has(part.id);
		case "end":
			return false;
	}
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
