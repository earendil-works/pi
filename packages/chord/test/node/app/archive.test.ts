// Tests of address archives (slice 13 §4) on their own: pack and unpack round-trip a host directory (its store's
// export and its files, uploads under way left out); unpacking refuses an existing directory, a manifest `accept`
// refuses, an archive not starting with its manifest and an entry outside the format, each leaving nothing behind.
// The round trip of a live worker's documents, tables and files is in `app.test.ts`.

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { type ArchiveManifest, packData, unpackData } from "../../../src/node/app/archive.ts";
import { writeTar } from "../../../src/node/app/tar.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { encodeJsonl, openStore, sqliteBackend } from "../../../src/store/index.ts";
import { tempDir } from "./support.ts";

const MANIFEST: ArchiveManifest = { format: 1, app: "acme", api: "v1", address: { kind: "doc", key: "doc|1" } };

/** A host directory with a fresh store and files `files/a` and `files/sub/b`, plus an upload under way. */
async function hostDirectory(base: string): Promise<string> {
	const dir = join(base, "host");
	await mkdir(join(dir, "files", "sub"), { recursive: true });
	await mkdir(join(dir, "files", ".uploads", "run"), { recursive: true });
	await (await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "store.sqlite"))), context)).close(
		context,
	);
	await writeFile(join(dir, "files", "a"), "file a");
	await writeFile(join(dir, "files", "sub", "b"), "file b");
	await writeFile(join(dir, "files", ".uploads", "run", "u"), "half");
	return dir;
}

/** The JSONL export of the store in `dir`. */
async function exported(dir: string): Promise<string> {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "store.sqlite"))), context);
	const chunks: Uint8Array[] = [];
	for await (const chunk of encodeJsonl(store.export(context))) chunks.push(chunk);
	await store.close(context);
	return Buffer.concat(chunks).toString();
}

/** An archive at `path` of `entries` (path and text), as an attacker could make one. */
async function forged(path: string, entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
	const tar = writeTar(
		entries.map(([name, text]) => {
			const bytes = new TextEncoder().encode(text);
			return {
				path: name,
				size: bytes.length,
				data: (async function* () {
					yield bytes;
				})(),
			};
		}),
	);
	await pipeline(tar, createWriteStream(path));
}

describe("pack and unpack", () => {
	it("round-trips a host directory's store and files, without uploads under way", async () => {
		const base = await tempDir();
		const dir = await hostDirectory(base);
		await packData(dir, MANIFEST, join(base, "out.tar"), context);
		const seen: ArchiveManifest[] = [];
		await unpackData(join(base, "out.tar"), join(base, "copy"), (manifest) => seen.push(manifest), {}, context);
		expect(seen).toEqual([MANIFEST]);
		expect((await readdir(join(base, "copy"))).sort()).toEqual(["files", "store.sqlite"]);
		expect((await readdir(join(base, "copy", "files"))).sort()).toEqual(["a", "sub"]);
		expect(await readFile(join(base, "copy", "files", "sub", "b"), "utf8")).toBe("file b");
		expect(await exported(join(base, "copy"))).toBe(await exported(dir));
		// No staging directory left beside either.
		expect((await readdir(base)).sort()).toEqual(["copy", "host", "out.tar"]);
	});

	it("refuses to pack an address without data", async () => {
		const base = await tempDir();
		await expect(packData(join(base, "none"), MANIFEST, join(base, "out.tar"), context)).rejects.toThrow(
			"has no data",
		);
	});
});

describe("refusals when unpacking", () => {
	it("refuses an archive past its limits: unpacked bytes and entries, counted before writing", async () => {
		const base = await tempDir();
		const big = "x".repeat(2000);
		const entries: Array<readonly [string, string]> = [
			["manifest.json", JSON.stringify(MANIFEST)],
			["store.archive", ""],
		];
		await forged(join(base, "big.tar"), [...entries, ["files/a", big], ["files/b", big]]);
		await expect(
			unpackData(join(base, "big.tar"), join(base, "a"), () => {}, { bytes: 3000 }, context),
		).rejects.toThrow("unpacks to more than 3000 bytes");
		await forged(join(base, "many.tar"), [
			...entries,
			...Array.from({ length: 5 }, (_, index) => [`files/${index}`, "x"] as const),
		]);
		await expect(
			unpackData(join(base, "many.tar"), join(base, "b"), () => {}, { entries: 4 }, context),
		).rejects.toThrow("more than 4 entries");
		expect((await readdir(base)).sort()).toEqual(["big.tar", "many.tar"]);
	});

	it("refuses an existing directory", async () => {
		const base = await tempDir();
		const dir = await hostDirectory(base);
		await packData(dir, MANIFEST, join(base, "out.tar"), context);
		await expect(unpackData(join(base, "out.tar"), dir, () => {}, {}, context)).rejects.toThrow("exists already");
	});

	it("refuses what `accept` refuses, an archive not starting with its manifest, and a foreign entry; leaves nothing", async () => {
		const base = await tempDir();
		await packData(await hostDirectory(base), MANIFEST, join(base, "out.tar"), context);
		const refuse = () => {
			throw new Error("not this app");
		};
		await expect(unpackData(join(base, "out.tar"), join(base, "a"), refuse, {}, context)).rejects.toThrow(
			"not this app",
		);
		await forged(join(base, "late.tar"), [
			["files/x", "x"],
			["manifest.json", JSON.stringify(MANIFEST)],
		]);
		await expect(unpackData(join(base, "late.tar"), join(base, "b"), () => {}, {}, context)).rejects.toThrow(
			"start with manifest.json",
		);
		await forged(join(base, "extra.tar"), [
			["manifest.json", JSON.stringify(MANIFEST)],
			["plugins/evil.ts", "x"],
		]);
		await expect(unpackData(join(base, "extra.tar"), join(base, "c"), () => {}, {}, context)).rejects.toThrow(
			"plugins/evil.ts",
		);
		await forged(join(base, "nostore.tar"), [["manifest.json", JSON.stringify(MANIFEST)]]);
		await expect(unpackData(join(base, "nostore.tar"), join(base, "d"), () => {}, {}, context)).rejects.toThrow(
			"no manifest.json or store.archive",
		);
		expect((await readdir(base)).sort()).toEqual(["extra.tar", "host", "late.tar", "nostore.tar", "out.tar"]);
	});
});
