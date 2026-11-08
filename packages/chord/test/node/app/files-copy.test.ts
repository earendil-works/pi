// Tests of copying a host's files (decision "Files v2"): a running host's `Files` index and blobs into a new host
// directory, nothing else of its store; the copy opens as a host of its own with every version, folder and summary,
// its blobs shared as links; an existing target is refused and a failed copy leaves nothing.

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { local, method, obj, str } from "../../../src/contracts/index.ts";
import { defineState } from "../../../src/documents/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";
import { copyFiles, Files, filesFacet } from "../../../src/node/app/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { openStore, type Store, sqliteBackend } from "../../../src/store/index.ts";
import { tempDir } from "./support.ts";

const encoder = new TextEncoder();

/** Another object of the same store, whose document a copy of the files must leave behind. */
const Notes = local("test.notes", { version: 1, params: {}, members: { text: str(), write: method(str()) } });

const NotesDoc = defineState("notes", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "" }),
	persist: true,
	checkpointWhen: () => false,
});

const notesFacet = defineFacet((host) =>
	host.serve(Notes, (_params, self) => {
		const doc = self.state(NotesDoc);
		return {
			text: self.derive([doc], ([value]) => value.text),
			write: async (text, ctx) => {
				await doc.change((draft) => {
					draft.text = text;
				}, ctx);
				return null;
			},
		};
	}),
);

/** A host on the store in `dir` with the files facet over `dir/files` and the notes object. */
async function hostAt(dir: string) {
	await mkdir(dir, { recursive: true });
	const store: Store = await openStore(
		sqliteBackend(await openNodeSqliteDatabase(join(dir, "store.sqlite"))),
		context,
	);
	const errors: unknown[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error) });
	await host.load(
		[
			{ name: "chord.app.files", facet: filesFacet(join(dir, "files")) },
			{ name: "test.notes", facet: notesFacet },
		],
		context,
	);
	const files = await host.get(Files, {}, context);
	const close = async (): Promise<void> => {
		files.release();
		await host.close(context);
		await store.close(context);
	};
	return { store, host, files, errors, close };
}

describe("copy", () => {
	it("copies a running host's index and blobs, and nothing else of its store", async () => {
		const base = await tempDir();
		const source = await hostAt(join(base, "source"));
		const { files } = source;
		const put = (space: string, path: string, text: string) =>
			files.put({ space, path, mime: "text/plain", source: "test", bytes: encoder.encode(text) }, context);
		const v1 = await put("artifacts", "report", "one");
		const v2 = await put("artifacts", "report", "two");
		await put("uploads", "docs/a.txt", "upload");
		await files.copy({ id: v1.id, space: "shared", path: "copy-of-report" }, context);
		const notes = await source.host.get(Notes, {}, context);
		await notes.write("not copied", context);
		notes.release();

		await copyFiles({ store: source.store, files: join(base, "source", "files") }, join(base, "copy"), context);
		// The source goes on.
		await put("artifacts", "report", "three");

		const copy = await hostAt(join(base, "copy"));
		const versions = await copy.files.versions({ space: "artifacts", path: "report" }, context);
		expect(versions.items.map(({ id }) => id)).toEqual([v2.id, v1.id]);
		const text = async (id: string) =>
			new TextDecoder().decode(await copy.files.read({ id, offset: 0, length: 100 }, context));
		expect(await text(v1.id)).toBe("one");
		expect((await copy.files.list({ space: "uploads", folder: "docs" }, context)).items).toHaveLength(1);
		expect(await copy.files.summary.get("artifacts", context)).toMatchObject({ files: 1, versions: 2 });
		// Blobs are shared files: the copy of `report` v1 in `shared` and v1 itself are one blob, linked once.
		const blobs = await readdir(join(base, "copy", "files", "blobs"));
		expect(blobs).toHaveLength(3);
		for (const blob of blobs) {
			const [a, b] = [join(base, "source", "files", "blobs", blob), join(base, "copy", "files", "blobs", blob)];
			expect((await stat(a)).ino).toBe((await stat(b)).ino);
		}
		const copiedNotes = await copy.host.get(Notes, {}, context);
		expect(copiedNotes.text.value).toBe("");
		copiedNotes.release();
		// Removing in the copy leaves the source's blob.
		await copy.files.removeSpace("artifacts", context);
		expect(new TextDecoder().decode(await files.read({ id: v1.id, offset: 0, length: 10 }, context))).toBe("one");
		expect([...source.errors, ...copy.errors]).toEqual([]);
		await copy.close();
		await source.close();
	});

	it("refuses a target that exists; a failed copy leaves nothing", async () => {
		const base = await tempDir();
		const source = await hostAt(join(base, "source"));
		const file = await source.files.put(
			{ space: "s", path: "a", mime: "x", source: "test", bytes: encoder.encode("a") },
			context,
		);
		await mkdir(join(base, "taken"));
		const sourceFiles = { store: source.store, files: join(base, "source", "files") };
		await expect(copyFiles(sourceFiles, join(base, "taken"), context)).rejects.toThrow("exists already");
		// A blob gone from disk fails the copy: nothing is left beside the target.
		const blob = (await readdir(join(base, "source", "files", "blobs")))[0]!;
		await rm(join(base, "source", "files", "blobs", blob));
		await expect(copyFiles(sourceFiles, join(base, "copy"), context)).rejects.toThrow();
		expect((await readdir(base)).sort()).toEqual(["source", "taken"]);
		expect(file.path).toBe("a");
		await source.close();
	});
});
