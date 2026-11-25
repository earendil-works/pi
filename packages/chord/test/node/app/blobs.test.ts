// Tests of a host's blob files on their own (decision "Files v2"): written whole and moved into place (mode 0600),
// read by range, removed, swept when the index does not know them, and put into another host's directory as a link.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Blobs } from "../../../src/node/app/blobs.ts";
import { tempDir } from "./support.ts";

const encoder = new TextEncoder();

describe("blob files", () => {
	it("writes a blob through its staging file, reads ranges, removes it", async () => {
		const base = await tempDir();
		const blobs = new Blobs(join(base, "blobs"));
		await blobs.write("b1", encoder.encode("hello blob"), join(base, "staging", "b1"));
		expect(await readdir(join(base, "staging"))).toEqual([]);
		expect((await stat(blobs.path("b1"))).mode & 0o777).toBe(0o600);
		expect(new TextDecoder().decode(await blobs.read("b1", 10, 6, 100))).toBe("blob");
		expect((await blobs.read("b1", 10, 20, 5)).length).toBe(0);
		await blobs.remove(["b1", "missing"]);
		expect(await readdir(join(base, "blobs"))).toEqual([]);
	});

	it("sweeps the blob files the index does not know", async () => {
		const base = await tempDir();
		const blobs = new Blobs(join(base, "blobs"));
		await blobs.prepare();
		for (const id of ["kept", "stray"]) await writeFile(blobs.path(id), id);
		await blobs.sweep(async (id) => id === "kept");
		expect(await readdir(join(base, "blobs"))).toEqual(["kept"]);
		// No directory yet: nothing to sweep.
		await new Blobs(join(base, "none")).sweep(async () => false);
	});

	it("puts a blob into another host's directory as a hard link, never over an existing one", async () => {
		const base = await tempDir();
		const blobs = new Blobs(join(base, "a"));
		await blobs.write("b1", encoder.encode("shared"), join(base, "staging"));
		const target = new Blobs(join(base, "b"));
		await target.prepare();
		await blobs.linkInto("b1", target.dir);
		expect(await readFile(target.path("b1"), "utf8")).toBe("shared");
		expect((await stat(target.path("b1"))).ino).toBe((await stat(blobs.path("b1"))).ino);
		await expect(blobs.linkInto("b1", target.dir)).rejects.toMatchObject({ code: "EEXIST" });
	});
});
