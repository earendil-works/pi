// Files (decision "Files v2"): the app kit's file storage, one `Files` object per host, its bytes in the host's
// `files/` and its index in the host's store. Every file lives in a space at a path; folders are index entries and a
// move changes only the index; bytes never change (a write to a path adds a version, a copy shares the bytes); a key
// makes a retried write store nothing; versions are found by path, folder, `ref` and `key`; `FilesFolder` lists one
// folder live; each space has a summary an app mirrors to its server; `copyFiles` copies a host's files to a new host.
// `startServer` and `startWorker` load `filesFacet` on their hosts; an app with hosts of its own loads it itself, as
// here.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/65-files.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { createHost } from "../../src/host/index.ts";
import { copyFiles, Files, FilesFolder, filesFacet } from "../../src/node/app/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { openStore, sqliteBackend } from "../../src/store/index.ts";

const context = BACKGROUND_CONTEXT;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dir = await mkdtemp(join(tmpdir(), "chord-files-"));

// A host with its store and the files facet over its files directory (`<host dir>/files`).
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "host", "store.sqlite"))), context);
const host = createHost({ store, onError: (error) => console.error("background error:", error) });
await host.load([{ name: "chord.app.files", facet: filesFacet(join(dir, "host", "files")) }], context);
const files = await host.get(Files, {}, context);
const text = async (id: string) => decoder.decode(await files.read({ id, offset: 0, length: 4096 }, context));

// 1. Writes: a space, a path (its folders are made), a type, who wrote it, a producer's reference, free `meta`.
const report = await files.put(
	{
		space: "shared",
		path: "docs/report.md",
		mime: "text/markdown",
		source: "owner",
		ref: "message-7",
		meta: { title: "Q3" },
		bytes: encoder.encode("# Report"),
	},
	context,
);
console.log("1. put:", report.path, "version", report.version, "meta", JSON.stringify(report.meta));

// 2. A second write to the path is version 2; the path names the newest, version 1 stays readable.
const second = await files.put(
	{
		space: "shared",
		path: "docs/report.md",
		mime: "text/markdown",
		source: "agent",
		bytes: encoder.encode("# Report v2"),
	},
	context,
);
const newest = await files.get({ space: "shared", path: "docs/report.md" }, context);
console.log(`2. versions: newest ${newest?.version} "${await text(second.id)}", v1 "${await text(report.id)}"`);

// 3. Folders are listed folders first, then each file's newest version; a live listing follows changes.
const docs = await host.get(FilesFolder, { space: "shared", folder: "docs" }, context);
const listed = () =>
	docs.listing.value.entries.map((entry) => (entry.kind === "folder" ? `${entry.folder.path}/` : entry.file.path));
console.log("3. docs:", listed());
await files.mkdir({ space: "shared", path: "docs/drafts" }, context);
await files.move({ space: "shared", from: "docs/report.md", to: "docs/drafts/report.md" }, context);
console.log("   after mkdir and move:", listed());

// 4. A key: a retried delivery (Discord's message 42, attachment 0) stores nothing the second time.
const delivery = {
	space: "discord",
	path: "inbox/photo.png",
	mime: "image/png",
	source: "discord",
	ref: "42",
	key: "discord:42:0",
	bytes: encoder.encode("png bytes"),
};
const first = await files.put(delivery, context);
const retried = await files.put(delivery, context);
console.log(
	"4. same file on retry:",
	first.id === retried.id,
	"versions:",
	(await files.summary.get("discord", context))?.versions,
);

// 5. Queries: by `ref`, by `key`; a copy shares the bytes.
console.log(
	"5. by ref 42:",
	(await files.byRef({ space: "discord", ref: "42" }, context)).items.map(({ path }) => path),
);
const copy = await files.copy({ id: first.id, space: "shared", path: "photo.png" }, context);
console.log("   copy:", copy.space, copy.path, "same bytes:", (await text(copy.id)) === (await text(first.id)));

// 6. Chunked writes for large files: begin, append at the stored offset, finish.
const begun = await files.begin(
	{ space: "shared", path: "big.bin", mime: "application/octet-stream", source: "owner" },
	context,
);
if (begun.kind === "upload") {
	const chunk = new Uint8Array(1024 * 1024).fill(1);
	for (let offset = 0; offset < 3 * chunk.length; offset += chunk.length) {
		await files.append({ upload: begun.upload, offset, bytes: chunk }, context);
	}
	console.log("6. chunked:", (await files.finish(begun.upload, context)).size, "bytes");
}

// 7. The summary of a space: what a worker pushes to its server's index, so lists show without starting it.
const summary = await files.summary.get("shared", context);
console.log(
	"7. shared:",
	summary?.files,
	"files,",
	summary?.versions,
	"versions,",
	summary?.bytes,
	"bytes; newest",
	summary?.newest[0]?.path,
);

// 8. Copying the host's files (index and bytes, nothing else of its store) into a new host's directory.
await copyFiles({ store, files: join(dir, "host", "files") }, join(dir, "copy"), context);
const copied = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "copy", "store.sqlite"))), context);
const other = createHost({ store: copied, onError: (error) => console.error("background error:", error) });
await other.load([{ name: "chord.app.files", facet: filesFacet(join(dir, "copy", "files")) }], context);
const otherFiles = await other.get(Files, {}, context);
console.log(
	"8. the copy's docs/drafts:",
	(await otherFiles.list({ space: "shared", folder: "docs/drafts" }, context)).items.length,
	"entry",
);

otherFiles.release();
await other.close(context);
await copied.close(context);
docs.release();
files.release();
await host.close(context);
await store.close(context);
await rm(dir, { recursive: true, force: true });
