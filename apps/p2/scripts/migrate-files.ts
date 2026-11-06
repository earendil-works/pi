// Moves a session's files of the layout before per-host stores into the session's `Files` (the app kit's), and
// verifies them: artifacts (`artifacts/<session>/<name>/<version>/version.json`: space `artifacts`, path = name, the
// same version numbers, title and type in `meta`), uploads (`uploads/<session>/<id>-<name>`: space `uploads`, key = the
// upload's id) and download snapshots (`downloads/<session>/<id>/{metadata.json,payload}`: space `downloads`, key = the
// snapshot's id). Ids stay, so transcripts' attachment ids, `/download` links and artifact cards resolve as before.
// Writes go through `Files`, so its index, blobs, caps and summaries are what the app makes itself. Each file keeps its
// time (`created`): the old file's modification time, the only time the old layout kept.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, Ref } from "../src/runtime/chord.ts";
import {
	ARTIFACTS,
	DOWNLOADS,
	type Files,
	MAX_DOWNLOAD_BYTES,
	readWhole,
	UPLOADS,
	writeChunks,
} from "../src/runtime/session-files.ts";

/** What a session's file migration moved. */
export type FileCounts = {
	readonly artifacts: number;
	readonly uploads: number;
	readonly downloads: number;
	readonly bytes: number;
};

/** A file of the old layout and where it goes. */
type OldFile = {
	readonly space: string;
	readonly path: string;
	readonly key?: string;
	readonly mime: string;
	readonly source: string;
	readonly meta: Record<string, string>;
	/** The old file whose bytes it is, or its text (an artifact's content). */
	readonly bytes: { readonly file: string } | { readonly text: string };
	/** An artifact's version number; ones the old layout skipped are made and removed, so no number moves. */
	readonly version?: number;
	/** When it was made: the old file's modification time (the old layout recorded no other). */
	readonly created: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** The files of session `id` in the old layout of `dataDir`, artifacts by name and version. */
export function oldFiles(dataDir: string, id: string): OldFile[] {
	const files: OldFile[] = [];
	const artifacts = join(dataDir, "artifacts", id);
	for (const name of names(artifacts)) {
		const versions = names(join(artifacts, name))
			.map(Number)
			.filter((version) => Number.isSafeInteger(version) && version > 0)
			.sort((a, b) => a - b);
		for (const version of versions) {
			const path = join(artifacts, name, String(version), "version.json");
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				info: { name: string; title: string; type: string; version: number };
				content: string;
			};
			if (parsed.info.name !== name || parsed.info.version !== version)
				throw new Error(`Artifact ${name} version ${version} names another`);
			files.push({
				space: ARTIFACTS,
				path: name,
				mime:
					{ html: "text/html", svg: "image/svg+xml", markdown: "text/markdown" }[parsed.info.type] ?? "text/plain",
				source: "agent",
				meta: { title: parsed.info.title, type: parsed.info.type },
				bytes: { text: parsed.content },
				// Written once, as the version was saved.
				created: modified(path),
				version,
			});
		}
	}
	const uploads = join(dataDir, "uploads", id);
	for (const file of names(uploads)) {
		const key = file.slice(0, 36);
		if (!UUID.test(key) || file[36] !== "-" || !statSync(join(uploads, file)).isFile()) continue;
		const name = file.slice(37);
		files.push({
			space: UPLOADS,
			path: file,
			key,
			mime: IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream",
			// Who uploaded it was not recorded.
			source: "unknown",
			meta: { name },
			bytes: { file: join(uploads, file) },
			created: modified(join(uploads, file)),
		});
	}
	const downloads = join(dataDir, "downloads", id);
	for (const key of names(downloads)) {
		const metadata = join(downloads, key, "metadata.json");
		if (!UUID.test(key) || !existsSync(metadata)) continue;
		const info = JSON.parse(readFileSync(metadata, "utf8")) as { id: string; name: string; size: number };
		if (info.id !== key) throw new Error(`Download ${key} names another`);
		files.push({
			space: DOWNLOADS,
			path: `${key}-${info.name}`,
			key,
			mime: "application/octet-stream",
			source: "agent",
			meta: { name: info.name },
			bytes: { file: join(downloads, key, "payload") },
			// Written last, when the snapshot was published.
			created: modified(metadata),
		});
	}
	return files;
}

/** Writes the old files of session `id` into its `Files` (`files`, empty); what it moved. */
export async function migrateFiles(
	dataDir: string,
	id: string,
	files: Ref<typeof Files>,
	ctx: Ctx,
): Promise<FileCounts> {
	const counts = { artifacts: 0, uploads: 0, downloads: 0, bytes: 0 };
	const skipped: string[] = [];
	for (const old of oldFiles(dataDir, id)) {
		// A version the old layout never finished: a placeholder keeps its number taken, removed below.
		for (
			let next = (await files.get({ space: old.space, path: old.path }, ctx))?.version ?? 0;
			next + 1 < (old.version ?? 0);
			next++
		) {
			const hole = await files.put(
				{ space: old.space, path: old.path, mime: "text/plain", source: "migration", bytes: new Uint8Array() },
				ctx,
			);
			skipped.push(hole.id);
		}
		const write = {
			space: old.space,
			path: old.path,
			mime: old.mime,
			source: old.source,
			meta: old.meta,
			created: old.created,
			...(old.key === undefined ? {} : { key: old.key }),
		};
		const file =
			"text" in old.bytes
				? await files.put({ ...write, bytes: Buffer.from(old.bytes.text, "utf8") }, ctx)
				: await writeChunks(files, write, reader(old.bytes.file), MAX_DOWNLOAD_BYTES * 4, ctx);
		if (old.version !== undefined && file.version !== old.version)
			throw new Error(`Artifact ${old.path} version ${old.version} became version ${file.version}`);
		counts.bytes += file.size;
		if (old.space === ARTIFACTS) counts.artifacts++;
		else if (old.space === UPLOADS) counts.uploads++;
		else counts.downloads++;
	}
	for (const hole of skipped) await files.remove(hole, ctx);
	return counts;
}

/** Checks that every old file of session `id` reads back from `files` byte for byte, with its metadata. */
export async function verifyFiles(dataDir: string, id: string, files: Ref<typeof Files>, ctx: Ctx): Promise<void> {
	for (const old of oldFiles(dataDir, id)) {
		const file =
			old.key !== undefined
				? await files.byKey({ space: old.space, key: old.key }, ctx)
				: await files.get({ space: old.space, path: old.path, version: old.version }, ctx);
		const what = `${old.space}:${old.path}${old.version === undefined ? "" : ` v${old.version}`}`;
		if (file === null || file.path !== old.path) throw new Error(`${what} is missing after the migration`);
		if (JSON.stringify(file.meta) !== JSON.stringify(old.meta)) throw new Error(`${what}'s metadata differs`);
		if (file.created !== old.created) throw new Error(`${what}'s time differs`);
		const expected = "text" in old.bytes ? Buffer.from(old.bytes.text, "utf8") : readFileSync(old.bytes.file);
		if (!expected.equals(await readWhole(files, file, ctx))) throw new Error(`${what}'s bytes differ`);
	}
}

/** The names in `directory` (sorted, hidden ones left out), none when it does not exist. */
function names(directory: string): string[] {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
	return readdirSync(directory)
		.filter((name) => !name.startsWith("."))
		.sort();
}

/** The modification time of `path`, in whole ms (as `Files` keeps times). */
function modified(path: string): number {
	return Math.floor(statSync(path).mtimeMs);
}

/** The bytes of `path` a chunk at a time, then none. */
function reader(path: string): () => Promise<Uint8Array> {
	const chunks = createReadStream(path, { highWaterMark: 1024 * 1024 })[Symbol.asyncIterator]();
	return async () => {
		const next = await chunks.next();
		return next.done === true ? new Uint8Array() : (next.value as Buffer);
	};
}
