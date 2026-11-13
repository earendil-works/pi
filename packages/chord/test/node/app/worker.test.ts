// Tests of `startWorker` (slice 13 §1, §4) through a running app: a worker's store and files live in its own directory
// and outlast its process (stopped, then started again by the next hold), and its `Files` are its own.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { writePlugin } from "../plugins/support.ts";
import { NOTES_PLUGIN, Notes, Project, tempDir, testApp } from "./support.ts";

describe("a worker's directory", () => {
	it("keeps its store and files in workers/<kind>/<key>/ across its process's restarts", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		const { app, dataDir } = await testApp({ root, withWorkers: true });
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		await notes.write("kept", context);
		const file = await notes.attach("in p1's files", context);
		notes.release();
		const dir = join(dataDir, "workers", "project", "project%7Cp1");
		expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(["files", "store.sqlite"]));
		// The file's bytes are one blob in `files/blobs/`; its version id is the index's.
		const [blob, ...more] = await readdir(join(dir, "files", "blobs"));
		expect(more).toEqual([]);
		const mode = async (path: string) => (await stat(path)).mode & 0o777;
		const paths = [
			dir,
			join(dir, ".."),
			join(dir, "store.sqlite"),
			join(dir, "files"),
			join(dir, "files", "blobs", blob!),
		];
		expect(await Promise.all(paths.map(mode))).toEqual([0o700, 0o700, 0o600, 0o700, 0o600]);
		const workers = app.workers.get("project")!;
		await workers.stop(Project({ id: "p1" }), context);
		await workers.retry(Project({ id: "p1" }), context);
		const again = await app.host.get(Notes, { id: "p1" }, context);
		expect(again.text.value).toBe("kept");
		expect(await again.file(file, context)).toBe("in p1's files");
		// Another address has its own files: p1's id is unknown there.
		const other = await app.host.get(Notes, { id: "p2" }, context);
		await expect(other.file(file, context)).rejects.toMatchObject({ code: "invalid" });
		again.release();
		other.release();
		await app.close(context);
	}, 60_000);
});
