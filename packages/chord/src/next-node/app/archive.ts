// Address archives (slice 13 §4, decision "The app kit, point 5" (export and import per address)): one tar of a
// worker's address, `manifest.json` (the app, its API version, the kit's format version), `store.archive` (the store's
// export archive, slice 6a, as JSONL) and `files/` (its files directory). Packing reads a stopped worker's directory;
// unpacking makes a new directory for an address that has none, refusing every path that would leave it.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "../../context/index.ts";
import { decodeJsonl, encodeJsonl, importStore, openStore, sqliteBackend } from "../../next/store/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { privateDirectory, privateStore } from "./layout.ts";
import { readTar, type TarEntry, writeTar } from "./tar.ts";

/** The kit's archive format version. */
export const ARCHIVE_FORMAT = 1;

/** What an archive says about itself. */
export type ArchiveManifest = {
	readonly format: number;
	readonly app: string;
	readonly api: string;
	readonly address: { readonly kind: string; readonly key: string };
};

/** The store file of a host directory. */
const STORE = "store.sqlite";

/**
 * Packs the host directory `dir` (its worker stopped: nothing writes it) into the archive at `path`: `manifest`, its
 * store's export (an empty store's when it has none yet) and its `files/` (uploads under way left out).
 */
export async function packAddress(
	dir: string,
	manifest: ArchiveManifest,
	path: string,
	context: Context,
): Promise<void> {
	if (!(await exists(dir))) throw new Error(`exportAddress: ${manifest.address.key} has no data`);
	const staging = await mkdtemp(join(dirname(path), ".chord-export-"));
	try {
		const exported = join(staging, "store.archive");
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, STORE))), context);
		try {
			await pipeline(encodeJsonl(store.export(context)), createWriteStream(exported));
		} finally {
			await store.close(context);
		}
		const text = new TextEncoder().encode(JSON.stringify(manifest));
		const entries: TarEntry[] = [
			{ path: "manifest.json", size: text.length, data: chunksOf(text) },
			{ path: "store.archive", size: (await stat(exported)).size, data: createReadStream(exported) },
			...(await filesOf(join(dir, "files"))),
		];
		const written = join(staging, "archive.tar");
		await pipeline(writeTar(entries), createWriteStream(written, { mode: 0o600 }));
		await rename(written, path);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** One chunk. */
async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

/** The files under `root` as entries `files/<relative path>` (hidden ones, uploads under way, left out). */
async function filesOf(root: string): Promise<TarEntry[]> {
	const entries: TarEntry[] = [];
	const walk = async (dir: string): Promise<void> => {
		let names: string[];
		try {
			names = (await readdir(dir)).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const path = join(dir, name);
			const info = await stat(path);
			if (info.isDirectory()) await walk(path);
			else if (info.isFile()) {
				const inside = relative(root, path).split(sep).join("/");
				entries.push({ path: `files/${inside}`, size: info.size, data: createReadStream(path) });
			}
		}
	};
	await walk(root);
	return entries;
}

/** What an import takes at most: unpacked bytes (4 GiB by default) and entries (100,000 by default). */
export type ImportLimits = { readonly bytes?: number; readonly entries?: number };

/**
 * Unpacks the archive at `archive` into the new host directory `dir` (refused when it exists): its manifest checked by
 * `accept` (a throw refuses it), the store made from `store.archive`, `files/` restored, within `limits`. Staged beside
 * `dir` (mode 0700, files 0600) and renamed into place at the end, so a refused or broken archive leaves nothing.
 */
export async function unpackAddress(
	archive: string,
	dir: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<void> {
	if (await exists(dir)) throw new Error(`importAddress: ${dir} exists already (an address is imported once)`);
	await privateDirectory(dirname(dir));
	const staging = await mkdtemp(join(dirname(dir), ".chord-import-"));
	try {
		const storeArchive = await unpackEntries(archive, staging, accept, limits, context);
		await privateStore(join(staging, STORE));
		const backend = sqliteBackend(await openNodeSqliteDatabase(join(staging, STORE)));
		const store = await importStore(backend, decodeJsonl(createReadStream(storeArchive)), context);
		await store.close(context);
		await rm(storeArchive);
		await rename(staging, dir);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Writes the entries of `archive` into `staging`: the manifest first (checked by `accept` before any data is written),
 * then `store.archive` and `files/…`, within `limits` (counted from the headers, before an entry is written). The path
 * of the staged `store.archive`.
 */
async function unpackEntries(
	archive: string,
	staging: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<string> {
	const maxBytes = limits.bytes ?? 4 * 1024 ** 3;
	const maxEntries = limits.entries ?? 100_000;
	let manifest: ArchiveManifest | undefined;
	let storeArchive: string | undefined;
	let bytes = 0;
	let entries = 0;
	for await (const entry of readTar(createReadStream(archive))) {
		context.abortSignal?.throwIfAborted();
		if (++entries > maxEntries) throw new Error(`importAddress: the archive has more than ${maxEntries} entries`);
		if (entry.kind === "directory") continue;
		bytes += entry.size;
		if (bytes > maxBytes) throw new Error(`importAddress: the archive unpacks to more than ${maxBytes} bytes`);
		if (manifest === undefined && entry.path !== "manifest.json") {
			throw new Error("importAddress: the archive does not start with manifest.json");
		}
		if (entry.path === "manifest.json") {
			// A trust boundary: the archive's own description, checked by `accept`.
			manifest = JSON.parse(new TextDecoder().decode(await collect(entry.data, 64 * 1024))) as ArchiveManifest;
			accept(manifest);
		} else if (entry.path === "store.archive") {
			storeArchive = join(staging, "store.archive");
			await pipeline(entry.data, createWriteStream(storeArchive, { mode: 0o600 }));
		} else if (entry.path.startsWith("files/")) {
			// `readTar` refused absolute paths and `..`: `files/<path>` stays inside the staging directory.
			const target = join(staging, ...entry.path.split("/"));
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			await pipeline(entry.data, createWriteStream(target, { mode: 0o600 }));
		} else {
			throw new Error(`importAddress: the archive holds ${entry.path}, which an address archive does not`);
		}
	}
	if (manifest === undefined || storeArchive === undefined) {
		throw new Error("importAddress: the archive has no manifest.json or store.archive");
	}
	return storeArchive;
}

/** The bytes of `data`, refused past `limit`. */
async function collect(data: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of data) {
		size += chunk.length;
		if (size > limit) throw new Error("importAddress: manifest.json is too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
