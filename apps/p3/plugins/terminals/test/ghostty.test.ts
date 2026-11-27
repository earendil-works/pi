// The vendored libghostty-vt (vendor/ghostty): the file is the release build its README names, by its SHA-256, so an
// update changes the file and the README together. (The bindings themselves run in the browser: the page test.)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

/** The vendored files. */
const VENDOR = new URL("../vendor/ghostty/", import.meta.url);

describe("the vendored libghostty-vt", () => {
	it("is the file its README names by SHA-256", async () => {
		const readme = await readFile(new URL("README.md", VENDOR), "utf8");
		const named = /SHA-256: `([0-9a-f]{64})`/.exec(readme)?.[1];
		const actual = createHash("sha256")
			.update(await readFile(new URL("ghostty-vt.wasm", VENDOR)))
			.digest("hex");
		assert.equal(actual, named);
	});
});
