// Tests of `Files` and `FilesFolder` (slice 13 §4, decision "Files v2"), on the server's host: spaces, paths and
// folders, versions and blob references, keys, metadata queries, live folder listings, chunked uploads, the caps and
// the summary per space. Copying a host's files is in `files-copy.test.ts`, export and import in `archive.test.ts`.

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { type FileInfo, Files, FilesFolder, type FileWrite } from "../../../src/node/app/index.ts";
import { rejection } from "../../support.ts";
import { testApp } from "./support.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type FilesRef = Awaited<ReturnType<typeof filesOf>>;

/** The server's `Files` of a fresh test app. */
async function filesOf(options: Parameters<typeof testApp>[0] = {}) {
	const started = await testApp(options);
	const files = await started.app.host.get(Files, {}, context);
	const close = async (): Promise<void> => {
		files.release();
		await started.app.close(context);
	};
	return Object.assign(files, { started, close });
}

/** Writes `text` at `path` of `space` (default `shared`), written by `test`. */
function put(files: FilesRef, path: string, text: string, write: Partial<FileWrite> = {}): Promise<FileInfo> {
	return files.put(
		{ space: "shared", path, mime: "text/plain", source: "test", ...write, bytes: encoder.encode(text) },
		context,
	);
}

/** The text of version `id`. */
async function text(files: FilesRef, id: string): Promise<string> {
	return decoder.decode(await files.read({ id, offset: 0, length: 1 << 20 }, context));
}

/** The names of a folder's entries (`folder/` for folders). */
async function names(files: FilesRef, folder: string, space = "shared"): Promise<string[]> {
	const { items } = await files.list({ space, folder }, context);
	return items.map((entry) => (entry.kind === "folder" ? `${entry.folder.path}/` : entry.file.path));
}

/** The blob files on disk of the server's files. */
async function blobFiles(files: FilesRef): Promise<string[]> {
	return readdir(join(files.started.dataDir, "server", "files", "blobs")).catch(() => []);
}

describe("spaces", () => {
	it("keeps the same path apart in two spaces; refuses a name outside the rule", async () => {
		const files = await filesOf();
		const shared = await put(files, "a.txt", "shared");
		const other = await put(files, "a.txt", "artifacts", { space: "artifacts" });
		expect([shared.version, other.version]).toEqual([1, 1]);
		expect(await text(files, (await files.get({ space: "artifacts", path: "a.txt" }, context))!.id)).toBe(
			"artifacts",
		);
		for (const space of ["", "Upper", "a/b", "x".repeat(65)]) {
			expect(await rejection(put(files, "a.txt", "x", { space }))).toMatchObject({ code: "invalid" });
		}
		await files.close();
	});

	it("removes a space: its files, folders, summary and the blobs only it used", async () => {
		const files = await filesOf();
		await put(files, "docs/a.txt", "a", { space: "scratch" });
		const kept = await put(files, "b.txt", "b");
		await files.copy({ id: kept.id, space: "scratch", path: "b.txt" }, context);
		expect((await blobFiles(files)).length).toBe(2);
		await files.removeSpace("scratch", context);
		expect(await names(files, "", "scratch")).toEqual([]);
		expect(await files.summary.get("scratch", context)).toBeUndefined();
		expect(await blobFiles(files)).toHaveLength(1);
		expect(await text(files, kept.id)).toBe("b");
		await files.close();
	});
});

describe("paths and folders", () => {
	it("makes the folders of a path; lists folders first, then files, each by path", async () => {
		const files = await filesOf();
		await put(files, "docs/a/report.md", "r");
		await put(files, "docs/b.md", "b");
		await put(files, "readme.md", "x");
		await files.mkdir({ space: "shared", path: "empty/inner" }, context);
		expect(await names(files, "")).toEqual(["docs/", "empty/", "readme.md"]);
		expect(await names(files, "docs")).toEqual(["docs/a/", "docs/b.md"]);
		expect(await names(files, "empty")).toEqual(["empty/inner/"]);
		expect((await files.mkdir({ space: "shared", path: "docs" }, context)).path).toBe("docs");
		await files.close();
	});

	it("pages a listing across its folders and files with cursors", async () => {
		const files = await filesOf();
		for (const name of ["f1", "f2", "f3"]) await files.mkdir({ space: "shared", path: name }, context);
		for (const name of ["a", "b", "c"]) await put(files, `${name}.txt`, name);
		const seen: string[] = [];
		let after: string | undefined;
		for (;;) {
			const page = await files.list({ space: "shared", folder: "", limit: 2, ...(after ? { after } : {}) }, context);
			seen.push(...page.items.map((entry) => (entry.kind === "folder" ? entry.folder.path : entry.file.path)));
			if (page.next === undefined) break;
			after = page.next;
		}
		expect(seen).toEqual(["f1", "f2", "f3", "a.txt", "b.txt", "c.txt"]);
		// A page the folders fill exactly continues only when files follow.
		const folders = await filesOf();
		await folders.mkdir({ space: "shared", path: "only" }, context);
		expect(await folders.list({ space: "shared", folder: "", limit: 1 }, context)).toEqual({
			items: [{ kind: "folder", folder: { space: "shared", path: "only", created: expect.any(Number) } }],
		});
		expect(await rejection(files.list({ space: "shared", folder: "", after: "nope" }, context))).toMatchObject({
			code: "invalid",
		});
		await folders.close();
		await files.close();
	});

	it("refuses bad paths, a file where a folder is and a folder where a file is", async () => {
		const files = await filesOf();
		for (const path of ["", "/a", "a/", "a//b", "a/../b", ".", "a/./b", "a\0b", "x".repeat(1025)]) {
			expect(await rejection(put(files, path, "x"))).toMatchObject({ code: "invalid" });
		}
		await put(files, "docs/a.txt", "a");
		expect(await rejection(put(files, "docs", "x"))).toMatchObject({
			code: "invalid",
			details: { conflict: "docs" },
		});
		expect(await rejection(put(files, "docs/a.txt/b", "x"))).toMatchObject({
			code: "invalid",
			details: { conflict: "docs/a.txt" },
		});
		expect(await rejection(files.mkdir({ space: "shared", path: "docs/a.txt" }, context))).toMatchObject({
			code: "invalid",
		});
		expect(
			await rejection(files.begin({ space: "shared", path: "docs", mime: "x", source: "t" }, context)),
		).toMatchObject({ code: "invalid" });
		await files.close();
	});

	it("moves a file with all its versions, changing only the index", async () => {
		const files = await filesOf();
		const first = await put(files, "a.txt", "1");
		await put(files, "a.txt", "2");
		const blobs = await blobFiles(files);
		await files.move({ space: "shared", from: "a.txt", to: "archive/b.txt" }, context);
		expect(await names(files, "")).toEqual(["archive/"]);
		expect(await names(files, "archive")).toEqual(["archive/b.txt"]);
		const { items } = await files.versions({ space: "shared", path: "archive/b.txt" }, context);
		expect(items.map(({ version }) => version)).toEqual([2, 1]);
		expect(await text(files, first.id)).toBe("1");
		expect(await blobFiles(files)).toEqual(blobs);
		await files.close();
	});

	it("moves a folder with everything under it; refuses a target that exists or lies inside", async () => {
		const files = await filesOf();
		await put(files, "docs/a.txt", "a");
		await put(files, "docs/sub/b.txt", "b");
		await put(files, "docsx/c.txt", "c");
		await put(files, "taken.txt", "t");
		await files.move({ space: "shared", from: "docs", to: "old/docs" }, context);
		expect(await names(files, "")).toEqual(["docsx/", "old/", "taken.txt"]);
		expect(await names(files, "old/docs")).toEqual(["old/docs/sub/", "old/docs/a.txt"]);
		expect(await names(files, "old/docs/sub")).toEqual(["old/docs/sub/b.txt"]);
		expect(await names(files, "docsx")).toEqual(["docsx/c.txt"]);
		expect(await files.get({ space: "shared", path: "old/docs/sub/b.txt" }, context)).toMatchObject({ version: 1 });
		expect(await rejection(files.move({ space: "shared", from: "old", to: "old/inner" }, context))).toMatchObject({
			code: "invalid",
		});
		expect(await rejection(files.move({ space: "shared", from: "old", to: "taken.txt" }, context))).toMatchObject({
			code: "invalid",
			details: { conflict: "taken.txt" },
		});
		expect(await rejection(files.move({ space: "shared", from: "missing", to: "x" }, context))).toMatchObject({
			code: "invalid",
		});
		await files.close();
	});

	it("removes a folder with everything under it, and a file with every version", async () => {
		const files = await filesOf();
		await put(files, "docs/a.txt", "a");
		await put(files, "docs/sub/b.txt", "b");
		await put(files, "c.txt", "1");
		await put(files, "c.txt", "2");
		await files.removePath({ space: "shared", path: "docs" }, context);
		expect(await names(files, "")).toEqual(["c.txt"]);
		await files.removePath({ space: "shared", path: "c.txt" }, context);
		expect(await names(files, "")).toEqual([]);
		expect(await blobFiles(files)).toEqual([]);
		await files.close();
	});
});

describe("versions and blob references", () => {
	it("adds a version per write; the path names the newest; older ones stay readable", async () => {
		const files = await filesOf();
		const v1 = await put(files, "a.txt", "one");
		const v2 = await put(files, "a.txt", "two");
		expect([v1.version, v2.version]).toEqual([1, 2]);
		expect((await files.get({ space: "shared", path: "a.txt" }, context))?.id).toBe(v2.id);
		expect((await files.get({ space: "shared", path: "a.txt", version: 1 }, context))?.id).toBe(v1.id);
		expect(await files.get({ space: "shared", path: "a.txt", version: 3 }, context)).toBeNull();
		expect(await text(files, v1.id)).toBe("one");
		const listed = (await files.list({ space: "shared", folder: "" }, context)).items;
		expect(listed).toEqual([{ kind: "file", file: v2 }]);
		await files.close();
	});

	it("removing the newest version makes the next older one the newest", async () => {
		const files = await filesOf();
		const v1 = await put(files, "a.txt", "one");
		const v2 = await put(files, "a.txt", "two");
		await files.remove(v2.id, context);
		await files.remove(v2.id, context);
		expect((await files.get({ space: "shared", path: "a.txt" }, context))?.id).toBe(v1.id);
		// Version 2's number is never used again: a link to it must not show other bytes.
		expect((await put(files, "a.txt", "three")).version).toBe(3);
		expect(await rejection(files.read({ id: v2.id, offset: 0, length: 1 }, context))).toMatchObject({
			code: "invalid",
		});
		await files.close();
	});

	it("never uses a number twice for a path: removed entirely, moved away or onto a removed path", async () => {
		const files = await filesOf();
		await put(files, "a.txt", "1");
		await put(files, "a.txt", "2");
		await files.removePath({ space: "shared", path: "a.txt" }, context);
		expect((await put(files, "a.txt", "3")).version).toBe(3);
		await files.removeSpace("shared", context);
		expect((await put(files, "a.txt", "4")).version).toBe(4);
		// Moved away: the path left keeps its mark; moved onto a removed path: the higher mark of the two.
		await files.move({ space: "shared", from: "a.txt", to: "b.txt" }, context);
		expect((await put(files, "a.txt", "5")).version).toBe(5);
		await put(files, "docs/c.txt", "c1");
		await files.removePath({ space: "shared", path: "docs" }, context);
		await put(files, "old/c.txt", "o1");
		await files.move({ space: "shared", from: "old", to: "docs" }, context);
		expect((await put(files, "docs/c.txt", "next")).version).toBe(2);
		expect((await put(files, "b.txt", "b")).version).toBe(5);
		await files.close();
	});

	it("copies share a blob, deleted from disk once no version references it", async () => {
		const files = await filesOf();
		const original = await put(files, "a.txt", "shared bytes", { ref: "m1", meta: { n: 1 } });
		const copy = await files.copy({ id: original.id, space: "other", path: "b/c.txt" }, context);
		expect(copy).toMatchObject({ space: "other", path: "b/c.txt", version: 1, ref: "m1", meta: { n: 1 } });
		expect(await blobFiles(files)).toHaveLength(1);
		await files.remove(original.id, context);
		expect(await text(files, copy.id)).toBe("shared bytes");
		expect(await blobFiles(files)).toHaveLength(1);
		await files.remove(copy.id, context);
		expect(await blobFiles(files)).toEqual([]);
		await files.close();
	});

	it("sweeps blobs a write left without its commit at the next start", async () => {
		const first = await filesOf();
		const kept = await put(first, "a.txt", "kept");
		const blobs = join(first.started.dataDir, "server", "files", "blobs");
		await writeFile(join(blobs, "stray"), "x");
		await first.close();
		const second = await filesOf({ dataDir: first.started.dataDir, root: first.started.root });
		while ((await readdir(blobs)).includes("stray")) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await text(second, kept.id)).toBe("kept");
		await second.close();
	});
});

describe("keys", () => {
	it("stores a write with a key once: the second answers the first, in its space only", async () => {
		const files = await filesOf();
		const first = await put(files, "a.txt", "one", { key: "discord:1:0" });
		const again = await put(files, "b.txt", "two", { key: "discord:1:0" });
		expect(again).toEqual(first);
		expect(await files.byKey({ space: "shared", key: "discord:1:0" }, context)).toEqual(first);
		expect((await put(files, "a.txt", "x", { key: "discord:1:0", space: "other" })).space).toBe("other");
		expect(await names(files, "")).toEqual(["a.txt"]);
		// Removing the version frees its key.
		await files.remove(first.id, context);
		expect(await files.byKey({ space: "shared", key: "discord:1:0" }, context)).toBeNull();
		await files.close();
	});

	it("begins with a key: the file written with it, or the upload under way with it", async () => {
		const files = await filesOf();
		const write = { space: "shared", path: "big.bin", mime: "x", source: "test", key: "k1" };
		const begun = await files.begin(write, context);
		expect(begun.kind).toBe("upload");
		expect(await files.begin(write, context)).toEqual(begun);
		const upload = begun.kind === "upload" ? begun.upload : "";
		await files.append({ upload, offset: 0, bytes: encoder.encode("abc") }, context);
		const file = await files.finish(upload, context);
		expect(await files.begin(write, context)).toEqual({ kind: "exists", file });
		await files.close();
	});
});

describe("metadata queries", () => {
	it("keeps source, ref, key, mime and meta; finds versions by id, ref and key", async () => {
		const files = await filesOf();
		const a = await put(files, "a.png", "a", { mime: "image/png", source: "guest:g1", ref: "msg-1", meta: { w: 2 } });
		const b = await put(files, "b.png", "b", { source: "owner", ref: "msg-1", key: "k" });
		await put(files, "c.png", "c", { ref: "msg-2" });
		expect(a).toEqual({
			id: a.id,
			space: "shared",
			path: "a.png",
			version: 1,
			size: 1,
			mime: "image/png",
			source: "guest:g1",
			ref: "msg-1",
			created: expect.any(Number),
			meta: { w: 2 },
		});
		expect(await files.file(a.id, context)).toEqual(a);
		expect(await files.file("missing", context)).toBeNull();
		const page = await files.byRef({ space: "shared", ref: "msg-1", limit: 1 }, context);
		expect(page.items).toEqual([a]);
		expect((await files.byRef({ space: "shared", ref: "msg-1", after: page.next }, context)).items).toEqual([b]);
		expect(await files.byKey({ space: "shared", key: "k" }, context)).toEqual(b);
		await files.close();
	});
});

describe("imported times", () => {
	it("keeps an import's created time; the summary's newest stay in created order", async () => {
		const files = await filesOf();
		const fresh = await put(files, "fresh.txt", "now");
		const old = await put(files, "old.txt", "then", { created: 1_000 });
		expect(old.created).toBe(1_000);
		expect(await files.file(old.id, context)).toMatchObject({ created: 1_000 });
		const begun = await files.begin(
			{ space: "shared", path: "old.bin", mime: "x", source: "t", created: 2_000 },
			context,
		);
		const upload = begun.kind === "upload" ? begun.upload : "";
		await files.append({ upload, offset: 0, bytes: encoder.encode("x") }, context);
		expect((await files.finish(upload, context)).created).toBe(2_000);
		const newest = (await files.summary.get("shared", context))?.newest.map(({ path }) => path);
		expect(newest).toEqual([fresh.path, "old.bin", "old.txt"]);
		await files.close();
	});
});

describe("live folder queries", () => {
	it("lists a folder live through writes, moves and removals", async () => {
		const files = await filesOf();
		const { app } = files.started;
		await put(files, "docs/a.txt", "a");
		const folder = await app.host.get(FilesFolder, { space: "shared", folder: "docs" }, context);
		const paths = () =>
			folder.listing.value.entries.map((entry) => (entry.kind === "folder" ? entry.folder.path : entry.file.path));
		expect(paths()).toEqual(["docs/a.txt"]);
		await put(files, "docs/b.txt", "b");
		expect(paths()).toEqual(["docs/a.txt", "docs/b.txt"]);
		await files.mkdir({ space: "shared", path: "docs/sub" }, context);
		expect(paths()).toEqual(["docs/sub", "docs/a.txt", "docs/b.txt"]);
		await files.move({ space: "shared", from: "docs/a.txt", to: "elsewhere.txt" }, context);
		expect(paths()).toEqual(["docs/sub", "docs/b.txt"]);
		await files.removePath({ space: "shared", path: "docs" }, context);
		expect(folder.listing.value).toEqual({ entries: [], more: false });
		// Another space's change leaves it as it is.
		await put(files, "docs/c.txt", "c", { space: "other" });
		expect(paths()).toEqual([]);
		folder.release();
		await files.close();
	});

	it("shows the first 500 entries and whether more follow", async () => {
		const files = await filesOf();
		for (let index = 0; index < 501; index++) {
			await files.mkdir({ space: "shared", path: `d${String(index).padStart(3, "0")}` }, context);
		}
		const folder = await files.started.app.host.get(FilesFolder, { space: "shared", folder: "" }, context);
		expect(folder.listing.value.entries).toHaveLength(500);
		expect(folder.listing.value.more).toBe(true);
		folder.release();
		await files.close();
	});
});

describe("chunked uploads", () => {
	it("writes a large file in chunks: begin, append at the stored offset, finish", async () => {
		const files = await filesOf();
		const begun = await files.begin({ space: "shared", path: "big.bin", mime: "x", source: "test" }, context);
		const upload = begun.kind === "upload" ? begun.upload : "";
		const chunk = new Uint8Array(1024 * 1024).fill(7);
		for (let index = 0; index < 4; index++)
			await files.append({ upload, offset: index * chunk.length, bytes: chunk }, context);
		// A writer after a drop asks where to resume; an append elsewhere is refused with the stored offset.
		const offset = await files.uploaded(upload, context);
		expect(offset).toBe(4 * chunk.length);
		expect(await rejection(files.append({ upload, offset: 3 * chunk.length, bytes: chunk }, context))).toMatchObject({
			code: "invalid",
			details: { offset },
		});
		await files.append({ upload, offset, bytes: chunk }, context);
		expect(await names(files, "")).toEqual([]);
		const file = await files.finish(upload, context);
		expect(file).toMatchObject({ path: "big.bin", size: 5 * 1024 * 1024, version: 1 });
		const tail = await files.read({ id: file.id, offset: 5 * 1024 * 1024 - 2, length: 10 }, context);
		expect([...tail]).toEqual([7, 7]);
		expect(await rejection(files.append({ upload, offset: 0, bytes: chunk }, context))).toMatchObject({
			code: "invalid",
		});
		expect(await rejection(files.uploaded(upload, context))).toMatchObject({ code: "invalid" });
		const { errors } = files.started;
		await files.close();
		// The routine sweeping expired uploads ends with the object, quietly.
		expect(errors).toEqual([]);
	});

	it("writes appends sent without waiting at their own offsets, byte for byte (review H1)", async () => {
		const files = await filesOf();
		const begun = await files.begin({ space: "shared", path: "big.bin", mime: "x", source: "test" }, context);
		const upload = begun.kind === "upload" ? begun.upload : "";
		const size = 32 * 1024;
		const chunks = Array.from({ length: 250 }, (_, index) => new Uint8Array(size).fill(index));
		await Promise.all(chunks.map((bytes, index) => files.append({ upload, offset: index * size, bytes }, context)));
		expect(await files.uploaded(upload, context)).toBe(250 * size);
		const { id } = await files.finish(upload, context);
		for (let index = 0; index < chunks.length; index++) {
			const piece = await files.read({ id, offset: index * size, length: size }, context);
			expect(piece.every((byte) => byte === index % 256)).toBe(true);
		}
		await files.close();
	});

	it("finishes an upload only once the appends sent before it landed (review H1)", async () => {
		const files = await filesOf();
		const begun = await files.begin({ space: "shared", path: "x", mime: "x", source: "test" }, context);
		const upload = begun.kind === "upload" ? begun.upload : "";
		const size = 512 * 1024;
		const appends = Array.from({ length: 8 }, (_, index) =>
			files.append({ upload, offset: index * size, bytes: new Uint8Array(size).fill(index + 1) }, context),
		);
		const file = await files.finish(upload, context);
		await Promise.all(appends);
		expect(file.size).toBe(8 * size);
		expect([...(await files.read({ id: file.id, offset: 8 * size - 1, length: 10 }, context))]).toEqual([8]);
		await files.close();
	});

	it("caps the uploads under way per object: past it begin is refused busy; an ending one frees its slot (recheck N1)", async () => {
		const files = await filesOf({ limits: { uploads: 3 } });
		const fds = async () => (await readdir("/proc/self/fd")).length;
		const before = await fds();
		const begun: string[] = [];
		const write = (index: number) => ({ space: "shared", path: `u${index}`, mime: "x", source: "test" });
		for (let index = 0; index < 3; index++) {
			const result = await files.begin(write(index), context);
			if (result.kind === "upload") begun.push(result.upload);
		}
		expect(await rejection(files.begin(write(3), context))).toMatchObject({ code: "unavailable", reason: "busy" });
		expect((await fds()) - before).toBeLessThanOrEqual(3);
		await files.finish(begun[0]!, context);
		expect((await files.begin(write(4), context)).kind).toBe("upload");
		await files.close();
	});

	it("cancels an upload: its bytes no longer count, its slot is free", async () => {
		const files = await filesOf({ files: { maxTotal: 100 }, limits: { uploads: 1 } });
		const begun = await files.begin({ space: "shared", path: "u", mime: "x", source: "t" }, context);
		const upload = begun.kind === "upload" ? begun.upload : "";
		await files.append({ upload, offset: 0, bytes: new Uint8Array(90) }, context);
		await files.cancel(upload, context);
		expect(await rejection(files.uploaded(upload, context))).toMatchObject({ code: "invalid" });
		await files.put({ space: "shared", path: "p", mime: "x", source: "t", bytes: new Uint8Array(90) }, context);
		expect((await files.begin({ space: "shared", path: "v", mime: "x", source: "t" }, context)).kind).toBe("upload");
		await files.close();
	});

	it("drops the uploads a previous run left", async () => {
		const first = await filesOf();
		await first.begin({ space: "shared", path: "left", mime: "x", source: "test" }, context);
		await first.close();
		const uploads = join(first.started.dataDir, "server", "files", ".uploads");
		const [left] = await readdir(uploads);
		await writeFile(join(uploads, "stray"), "x");
		const second = await filesOf({ dataDir: first.started.dataDir, root: first.started.root });
		const begun = await second.begin({ space: "shared", path: "new", mime: "x", source: "test" }, context);
		// The routine dropping them runs once the object is live; this run's upload stays.
		const dropped = async () => !(await readdir(uploads)).some((name) => name === left || name === "stray");
		while (!(await dropped())) await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await readdir(uploads)).length).toBe(1);
		const upload = begun.kind === "upload" ? begun.upload : "";
		await second.append({ upload, offset: 0, bytes: encoder.encode("kept") }, context);
		expect(await text(second, (await second.finish(upload, context)).id)).toBe("kept");
		await second.close();
	});
});

describe("caps", () => {
	it("refuses a file over the per-file cap and writes over the total; a copy adds no bytes", async () => {
		const files = await filesOf({ files: { maxFile: 1000, maxTotal: 1500 } });
		const putSized = (path: string, size: number) =>
			files.put({ space: "shared", path, mime: "x", source: "t", bytes: new Uint8Array(size) }, context);
		expect(await rejection(putSized("a", 1001))).toMatchObject({ code: "too_large" });
		const big = await putSized("a", 1000);
		expect(await rejection(putSized("b", 501))).toMatchObject({ code: "too_large" });
		await files.copy({ id: big.id, space: "shared", path: "a-copy" }, context);
		// An upload under way counts against the total.
		const begun = await files.begin({ space: "shared", path: "u", mime: "x", source: "t" }, context);
		const upload = begun.kind === "upload" ? begun.upload : "";
		await files.append({ upload, offset: 0, bytes: new Uint8Array(400) }, context);
		expect(await rejection(putSized("c", 101))).toMatchObject({ code: "too_large" });
		await putSized("c", 100);
		expect(await rejection(files.append({ upload, offset: 400, bytes: new Uint8Array(1) }, context))).toMatchObject({
			code: "too_large",
		});
		// Removing frees room.
		await files.removePath({ space: "shared", path: "c" }, context);
		await putSized("d", 100);
		await files.close();
	});

	it("refuses a put and a read of more than 4 MiB", async () => {
		const files = await filesOf();
		const limit = 4 * 1024 * 1024;
		const { id } = await put(files, "f", "0123456789");
		expect(await rejection(files.read({ id, offset: 0, length: limit + 1 }, context))).toMatchObject({
			code: "too_large",
		});
		expect(
			await rejection(
				files.put(
					{ space: "shared", path: "g", mime: "x", source: "t", bytes: new Uint8Array(limit + 1) },
					context,
				),
			),
		).toMatchObject({ code: "too_large" });
		await files.close();
	});
});

describe("summary", () => {
	it("counts a space's files, versions and bytes and keeps its newest versions", async () => {
		const files = await filesOf();
		const a1 = await put(files, "docs/a.txt", "1");
		const a2 = await put(files, "docs/a.txt", "22");
		const b = await put(files, "b.txt", "333");
		expect(await files.summary.get("shared", context)).toEqual({
			files: 2,
			versions: 3,
			bytes: 6,
			newest: [b, a2, a1],
		});
		await files.move({ space: "shared", from: "docs", to: "old" }, context);
		const moved = await files.summary.get("shared", context);
		expect(moved?.newest.map(({ path }) => path)).toEqual(["b.txt", "old/a.txt", "old/a.txt"]);
		await files.remove(b.id, context);
		expect(await files.summary.get("shared", context)).toMatchObject({ files: 1, versions: 2, bytes: 3 });
		await files.removePath({ space: "shared", path: "old" }, context);
		expect(await files.summary.get("shared", context)).toEqual({ files: 0, versions: 0, bytes: 0, newest: [] });
		await files.close();
	});

	it("keeps the newest 20 and stays across a restart", async () => {
		const first = await filesOf();
		for (let index = 0; index < 25; index++) await put(first, `f${index}`, "x");
		const summary = await first.summary.get("shared", context);
		expect(summary?.newest).toHaveLength(20);
		expect(summary?.newest[0]?.path).toBe("f24");
		await first.close();
		const second = await filesOf({ dataDir: first.started.dataDir, root: first.started.root });
		expect(await second.summary.get("shared", context)).toEqual(summary);
		await second.close();
	});
});
