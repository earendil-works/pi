// Tests of the oldest Node p3 runs on (`src/minimum-node.ts`): the comparison, and that it is `package.json`'s.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { MINIMUM_NODE, tooOld } from "../src/minimum-node.ts";

describe("the oldest Node p3 runs on", () => {
	it("is the one package.json's engines name", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			engines: { node: string };
		};
		assert.equal(manifest.engines.node, `>=${MINIMUM_NODE}`);
	});

	it("compares versions by number, not as text", () => {
		for (const version of ["24.3.9", "24.0.0", "23.99.99", "22.12.0", "9.99.99"]) assert.ok(tooOld(version), version);
		for (const version of ["24.4.0", "24.4.1", "24.10.0", "25.0.0", "26.11.1", "100.0.0"])
			assert.ok(!tooOld(version), version);
	});
});
