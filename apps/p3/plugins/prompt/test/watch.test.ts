// The folder watcher (`watch.ts`): which folder it watches (`watchable`: the folder itself when it exists, else its
// nearest existing ancestor up to the root; nothing for a folder linked out of the root, or with no root); a change
// under the watched folder is reported, also once a folder waited for is made and then changed; a move to another
// folder reports that one's changes; after `close` nothing is reported.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eventually } from "../../../test/until.ts";
import { FolderWatch, watchable } from "../watch.ts";

let dir: string;
let root: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "p3-prompt-watch-")));
	root = join(dir, "skills");
	await mkdir(root);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("the folder a watch watches", () => {
	it("is the folder when it exists, else its nearest existing ancestor up to the root", async () => {
		await mkdir(join(root, "a"));
		assert.deepEqual(await watchable(root, join(root, "a")), { at: join(root, "a"), real: join(root, "a") });
		assert.deepEqual(await watchable(root, join(root, "a", "b", "c")), {
			at: join(root, "a"),
			real: join(root, "a"),
		});
		assert.deepEqual(await watchable(root, join(root, "x")), { at: root, real: root });
	});

	it("is none for a folder linked out of the root, or with no root (Astra, round 2)", async () => {
		await mkdir(join(dir, "elsewhere"));
		await symlink(join(dir, "elsewhere"), join(root, "linked"));
		assert.equal(await watchable(root, join(root, "linked")), undefined);
		assert.equal(await watchable(root, join(root, "linked", "deeper")), undefined);
		await rm(root, { recursive: true });
		assert.equal(await watchable(root, join(root, "x")), undefined);
	});
});

describe("a folder watch", () => {
	/** A watch under the root counting its reports. */
	function counted(): { readonly watch: FolderWatch; readonly reports: () => number } {
		let reports = 0;
		return { watch: new FolderWatch(root, () => reports++), reports: () => reports };
	}

	/** Writes `file` again until `reports` grew past what it was before (the watch is armed asynchronously). */
	async function seen(reports: () => number, file: string): Promise<void> {
		const before = reports();
		await eventually(
			async () => {
				await writeFile(file, String(Date.now()));
				return reports();
			},
			(count) => count > before,
		);
	}

	it("reports a change under its folder, also once a folder waited for is made (Astra, round 1)", async () => {
		const { watch, reports } = counted();
		try {
			watch.watch(join(root, "later"));
			// The root is watched while `later` is missing.
			await seen(reports, join(root, "probe"));
			await mkdir(join(root, "later"));
			await seen(reports, join(root, "later", "SKILL.md"));
		} finally {
			watch.close();
		}
	});

	it("reports nothing of a folder after close, or after moving to another folder", async () => {
		await mkdir(join(root, "a"));
		await mkdir(join(root, "b"));
		const { watch, reports } = counted();
		const { watch: witness, reports: witnessed } = counted();
		try {
			watch.watch(join(root, "a"));
			await seen(reports, join(root, "a", "f"));
			watch.watch(join(root, "b"));
			await seen(reports, join(root, "b", "f"));
			watch.close();
			const closed = reports();
			// A second watch of the root sees the next writes in both: the closed one, watching nothing, does not.
			witness.watch(root);
			await seen(witnessed, join(root, "a", "f"));
			await seen(witnessed, join(root, "b", "f"));
			assert.equal(reports(), closed);
		} finally {
			watch.close();
			witness.close();
		}
	});
});
