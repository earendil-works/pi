// The output directory of a local release (`scripts/release-local.ts`): what the script refuses before it removes
// anything, and that `--force` removes only what a previous run made.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareOutput } from "../scripts/release-local.ts";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

/** A directory of test `t`'s own, removed after it. */
async function tempDir(t: TestContext): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "p3-out-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("a local release's output directory", () => {
	it("is refused when it is a root, the repository, above it or inside it, also through a link, forced or not", async (t) => {
		const link = join(await tempDir(t), "link");
		await symlink(dirname(REPOSITORY), link);
		const inside = [
			join(REPOSITORY, "apps", "p3", "out"),
			join(REPOSITORY, "..p3-release"),
			join(link, basename(REPOSITORY), "out"),
		];
		for (const out of [parse(REPOSITORY).root, REPOSITORY, dirname(REPOSITORY), link, ...inside]) {
			for (const force of [true, false]) {
				await assert.rejects(prepareOutput(out, force), /must be outside the repository/, out);
			}
		}
		assert.ok(!(await readdir(REPOSITORY)).includes("..p3-release"));
	});

	it("is made when missing and used when empty, and marked as this script's", async (t) => {
		const base = await tempDir(t);
		assert.equal(await prepareOutput(join(base, "new", "release"), false), join(base, "new", "release"));
		assert.deepEqual(await readdir(join(base, "new", "release")), [".p3-release"]);
		await mkdir(join(base, "empty"));
		await prepareOutput(join(base, "empty"), false);
		assert.deepEqual(await readdir(join(base, "empty")), [".p3-release"]);
	});

	it("is not touched when it holds anything but a release of this script, forced or not", async (t) => {
		const out = await tempDir(t);
		await writeFile(join(out, "notes.txt"), "mine");
		await mkdir(join(out, "install"));
		for (const force of [true, false]) {
			await assert.rejects(prepareOutput(out, force), /holds something else than a release of this script/);
		}
		assert.deepEqual((await readdir(out)).sort(), ["install", "notes.txt"]);
	});

	it("replaces a previous release only with --force, and removes only what the script made there", async (t) => {
		const out = await tempDir(t);
		await prepareOutput(out, false);
		for (const name of ["tarballs", "install", "kept"]) await mkdir(join(out, name));
		await writeFile(join(out, "install", "old"), "");
		await symlink("install", join(out, "p3"));
		await assert.rejects(prepareOutput(out, false), /holds a release \(pass --force to replace it\)/);
		assert.deepEqual(await readdir(join(out, "install")), ["old"]);
		await prepareOutput(out, true);
		assert.deepEqual((await readdir(out)).sort(), [".p3-release", "kept"]);
	});
});
