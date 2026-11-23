// Tests of which Pi a command line names: its data directory, the port it takes at its first start, and the named
// Pis there are. `HOME` is this file's own: the test runner gives every file a process.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_PORT, dataDirOf, firstPort, isPiName, namedPis } from "../src/pi.ts";

describe("a Pi", () => {
	let home: string;
	before(async () => {
		home = await realpath(await mkdtemp(join(tmpdir(), "p3-pi-")));
		process.env.HOME = home;
	});
	after(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("is the default one in ~/.pi/p3, a named one under its pis/, or any directory", () => {
		assert.equal(dataDirOf({}), join(home, ".pi", "p3"));
		assert.equal(dataDirOf({ pi: "work" }), join(home, ".pi", "p3", "pis", "work"));
		assert.equal(dataDirOf({ dir: "/somewhere/else" }), "/somewhere/else");
		assert.equal(dataDirOf({ dir: "relative" }), join(process.cwd(), "relative"));
	});

	it("takes port 8789 at its first start when it is the default one, else a free one", () => {
		assert.equal(DEFAULT_PORT, 8789);
		assert.deepEqual([firstPort(undefined), firstPort(join(home, ".pi", "p3"))], [8789, 8789]);
		assert.deepEqual([firstPort(dataDirOf({ pi: "work" })), firstPort("/somewhere/else")], [0, 0]);
	});

	it("is named by lower case letters, digits, - and _, at most 32, and never by a path", () => {
		for (const name of ["a", "work", "pi-2", "my_pi", "0", "a".repeat(32)]) assert.ok(isPiName(name), name);
		for (const name of ["", "A", "a b", "../x", "a/b", ".", "-a", "_a", "a".repeat(33), "ä"]) {
			assert.ok(!isPiName(name), name);
		}
	});

	it("lists the named Pis by name: the directories under pis/ that can name one; none before the first", async () => {
		assert.deepEqual(await namedPis(), []);
		const root = join(home, ".pi", "p3", "pis");
		for (const name of ["work", "b", "Not A Name"]) await mkdir(join(root, name), { recursive: true });
		await writeFile(join(root, "file"), "");
		assert.deepEqual(await namedPis(), [
			{ name: "b", dataDir: join(root, "b") },
			{ name: "work", dataDir: join(root, "work") },
		]);
	});
});
