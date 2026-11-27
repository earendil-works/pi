// The confined open (`openConfined`): a regular file or a folder inside the given real folder opens, the real folder
// itself too; a link at the last part, a path whose real place is outside (a link on the way), the wrong kind of file,
// a missing path and no folder at all are refused, and a refused open leaves no handle open.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openConfined } from "../confined.ts";

let dir: string;
let inside: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "p3-prompt-confined-")));
	inside = join(dir, "inside");
	await mkdir(join(inside, "folder"), { recursive: true });
	await writeFile(join(inside, "file"), "text");
	await mkdir(join(dir, "outside"));
	await writeFile(join(dir, "outside", "file"), "secret");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

/** Whether `path` opens as `kind` confined to `inside`; the handle is closed. */
async function opens(path: string, kind: "file" | "folder"): Promise<boolean> {
	const opened = await openConfined(inside, path, kind);
	await opened?.handle.close();
	return opened !== undefined;
}

describe("a confined open", () => {
	it("opens a file or folder inside, and the folder itself, reading the verified object", async () => {
		assert.equal(await opens(join(inside, "file"), "file"), true);
		assert.equal(await opens(join(inside, "folder"), "folder"), true);
		assert.equal(await opens(inside, "folder"), true);
		const opened = await openConfined(inside, join(inside, "file"), "file");
		try {
			assert.equal(opened?.real, join(inside, "file"));
			assert.equal(await opened?.handle.readFile("utf8"), "text");
		} finally {
			await opened?.handle.close();
		}
	});

	it("refuses a link, a place outside, the wrong kind, a missing path and no folder", async () => {
		await symlink(join(inside, "file"), join(inside, "link"));
		await symlink(join(dir, "outside"), join(inside, "out"));
		assert.equal(await opens(join(inside, "link"), "file"), false);
		assert.equal(await opens(join(inside, "out", "file"), "file"), false);
		assert.equal(await opens(join(dir, "outside", "file"), "file"), false);
		assert.equal(await opens(join(inside, "file"), "folder"), false);
		assert.equal(await opens(join(inside, "folder"), "file"), false);
		assert.equal(await opens(join(inside, "missing"), "file"), false);
		assert.equal(await openConfined(undefined, join(inside, "file"), "file"), undefined);
	});
});
