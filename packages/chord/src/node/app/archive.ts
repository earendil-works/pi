// Data archives (slice 13 §4, decisions "The app kit, point 5", "App kit naming and export" and "Documents and table
// rows can belong to a host"): one tar of the data a host created, `manifest.json` (the app, its API version, the kit's
// format version, the address), `store.archive` (the store's export archive, slice 6a, as JSONL: one consistent point,
// the export holding the commit queue while it reads), `server.archive` (the server's records and rows belonging to the
// address, `exportHostData`, as JSONL) and `files/` (its finished files). A running worker packs its own open store;
// without one the server packs the directory under the worker's lock. Unpacking makes a staging directory, refusing
// every path that would leave it; the kit puts it in place, then imports the server's part (`app.ts`).

import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "../../context/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { decodeJsonl, encodeJsonl, importStore, openStore, type Store, sqliteBackend } from "../../store/index.ts";
import { privateDirectory, privateStore } from "./layout.ts";
import { readTar, type TarEntry, writeTar } from "./tar.ts";

/** The kit's archive format version (2: `server.archive`). */
export const ARCHIVE_FORMAT = 2;

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
 * Packs the host directory `dir` of a host that does not run (its worker's lock held: nothing writes it) into the
 * archive at `path`: `manifest`, its store's export, the server's part (the JSONL file `server`) and its files.
 */
export async function packData(
	dir: string,
	manifest: ArchiveManifest,
	server: string,
	path: string,
	context: Context,
): Promise<void> {
	if (!(await exists(dir))) throw new Error(`exportData: ${manifest.address.key} has no data`);
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, STORE))), context);
	try {
		await packStore(store, join(dir, "files"), manifest, server, path, context);
	} finally {
		await store.close(context);
	}
}

/**
 * Packs the open `store`, the server's part (the JSONL file `server`, the server's records and rows belonging to the
 * address) and the files directory `files` into the archive at `path` (mode 0600, staged beside it and renamed):
 * `manifest`, the store's export (one consistent point, written while the host runs on), `server.archive` and the
 * finished files (uploads under way left out).
 */
export async function packStore(
	store: Store,
	files: string,
	manifest: ArchiveManifest,
	server: string,
	path: string,
	context: Context,
): Promise<void> {
	const staging = await mkdtemp(join(dirname(path), ".chord-export-"));
	try {
		const exported = join(staging, "store.archive");
		await pipeline(encodeJsonl(store.export(context)), createWriteStream(exported, { mode: 0o600 }));
		const text = new TextEncoder().encode(JSON.stringify(manifest));
		const size = (await stat(exported)).size;
		const serverSize = (await stat(server)).size;
		async function* entries(): AsyncGenerator<TarEntry> {
			yield { path: "manifest.json", size: text.length, data: chunksOf(text) };
			yield { path: "store.archive", size, data: createReadStream(exported) };
			yield { path: "server.archive", size: serverSize, data: createReadStream(server) };
			yield* filesOf(files);
		}
		const written = join(staging, "archive.tar");
		await pipeline(writeTar(entries()), createWriteStream(written, { mode: 0o600 }));
		await rename(written, path);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** One chunk. */
async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

/**
 * The files under `root` as entries `files/<relative path>` (hidden ones, uploads under way, left out), each opened only
 * when the archive comes to it (one descriptor at a time) and its size taken from the open file: a file deleted while a
 * running worker is exported is skipped, or read whole from its open handle (finished files never change; Opus L7).
 */
async function* filesOf(root: string): AsyncGenerator<TarEntry> {
	for (const path of await pathsUnder(root)) {
		const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (handle === undefined) continue;
		const info = await handle.stat();
		if (!info.isFile()) {
			await handle.close();
			continue;
		}
		const inside = relative(root, path).split(sep).join("/");
		yield {
			path: `files/${inside}`,
			size: info.size,
			data: handle.createReadStream({ start: 0, end: Math.max(0, info.size - 1) }),
		};
	}
}

/** The paths of the files under `root`, sorted, hidden ones left out (a directory gone meanwhile: none of it). */
async function pathsUnder(root: string): Promise<string[]> {
	const paths: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) paths.push(path);
		}
	};
	await walk(root);
	return paths;
}

/** What an import takes at most: unpacked bytes (4 GiB by default) and entries (100,000 by default). */
export type ImportLimits = { readonly bytes?: number; readonly entries?: number };

/**
 * Unpacks the archive at `archive` into a new staging directory in `parent` (mode 0700, files 0600): its manifest
 * checked by `accept` (a throw refuses it), the store made from `store.archive`, `files/` restored, `server.archive`
 * kept for the server, within `limits`. Changes nothing else: a refused or broken archive leaves nothing. The staging
 * directory and its server part's path; the caller renames it into place and then imports the server's part.
 */
export async function unpackStaging(
	archive: string,
	parent: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<{ readonly staging: string; readonly server: string }> {
	await privateDirectory(parent);
	const staging = await mkdtemp(join(parent, ".chord-import-"));
	try {
		const { store: storeArchive, server } = await unpackEntries(archive, staging, accept, limits, context);
		await privateStore(join(staging, STORE));
		const backend = sqliteBackend(await openNodeSqliteDatabase(join(staging, STORE)));
		const store = await importStore(backend, decodeJsonl(createReadStream(storeArchive)), context);
		await store.close(context);
		await rm(storeArchive);
		return { staging, server };
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Writes the entries of `archive` into `staging`: the manifest first (checked by `accept` before any data is written),
 * then `store.archive`, `server.archive` and `files/…`, within `limits` (counted from the headers, before an entry is
 * written). The paths of the staged `store.archive` and `server.archive`.
 */
async function unpackEntries(
	archive: string,
	staging: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<{ readonly store: string; readonly server: string }> {
	const maxBytes = limits.bytes ?? 4 * 1024 ** 3;
	const maxEntries = limits.entries ?? 100_000;
	let manifest: ArchiveManifest | undefined;
	let storeArchive: string | undefined;
	let serverArchive: string | undefined;
	let bytes = 0;
	let entries = 0;
	for await (const entry of readTar(createReadStream(archive))) {
		context.abortSignal?.throwIfAborted();
		if (++entries > maxEntries) throw new Error(`importData: the archive has more than ${maxEntries} entries`);
		if (entry.kind === "directory") continue;
		bytes += entry.size;
		if (bytes > maxBytes) throw new Error(`importData: the archive unpacks to more than ${maxBytes} bytes`);
		if (manifest === undefined && entry.path !== "manifest.json") {
			throw new Error("importData: the archive does not start with manifest.json");
		}
		if (entry.path === "manifest.json") {
			// A trust boundary: the archive's own description, checked by `accept`.
			manifest = JSON.parse(new TextDecoder().decode(await collect(entry.data, 64 * 1024))) as ArchiveManifest;
			accept(manifest);
		} else if (entry.path === "store.archive" || entry.path === "server.archive") {
			const target = join(staging, entry.path);
			if (entry.path === "store.archive") storeArchive = target;
			else serverArchive = target;
			await pipeline(entry.data, createWriteStream(target, { mode: 0o600 }));
		} else if (entry.path.startsWith("files/")) {
			// `readTar` refused absolute paths and `..`: `files/<path>` stays inside the staging directory.
			const target = join(staging, ...entry.path.split("/"));
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			await pipeline(entry.data, createWriteStream(target, { mode: 0o600 }));
		} else {
			throw new Error(`importData: the archive holds ${entry.path}, which an address archive does not`);
		}
	}
	if (manifest === undefined || storeArchive === undefined || serverArchive === undefined) {
		throw new Error("importData: the archive has no manifest.json, store.archive or server.archive");
	}
	return { store: storeArchive, server: serverArchive };
}

/** The bytes of `data`, refused past `limit`. */
async function collect(data: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of data) {
		size += chunk.length;
		if (size > limit) throw new Error("importData: manifest.json is too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** Whether `path` exists. */
export async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
