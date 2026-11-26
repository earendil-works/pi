// The catalog requests of p3's real command (`p3 server`, launched as its own process; Opus and Astra, round 1 of the
// catalog): it asks the catalog server `P3_CATALOG_URL` names, and with the variable `off` (as every test's p3 has it,
// `offline` in `test/support.ts`) no catalog request leaves it, also none to pi.dev.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { COMMAND } from "../../../src/install.ts";
import { launch } from "../../../test/support.ts";
import { eventually } from "../../../test/until.ts";
import { fakePiDev } from "./fake-pi-dev.ts";

/**
 * p3's command launched on a fresh data directory with `catalog` as `P3_CATALOG_URL`, every `fetch` of its process
 * written down (its URL only, by a module Node loads first); stopped and removed after the test. Answers the catalog
 * requests it made so far.
 */
async function launched(t: TestContext, catalog: string): Promise<() => Promise<string[]>> {
	const dir = await mkdtemp(join(tmpdir(), "p3-catalog-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const log = join(dir, "fetches.log");
	const hook = join(dir, "fetches.mjs");
	await writeFile(
		hook,
		[
			'import { appendFileSync } from "node:fs";',
			"const original = globalThis.fetch;",
			"globalThis.fetch = (input, init) => {",
			`	appendFileSync(${JSON.stringify(log)}, String(input instanceof Request ? input.url : input) + "\\n");`,
			"	return original(input, init);",
			"};",
		].join("\n"),
	);
	await writeFile(log, "");
	const env = { ...process.env, P3_CATALOG_URL: catalog, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}` };
	const server = await launch(COMMAND, join(dir, "pi"), env);
	t.after(() => server.stop());
	return async () => (await readFile(log, "utf8")).split("\n").filter((url) => url.includes("/api/models/"));
}

describe("the command's catalog requests", () => {
	it("go to the catalog server P3_CATALOG_URL names", async (t) => {
		const fake = await fakePiDev();
		t.after(() => fake.close());
		const fetches = await launched(t, fake.baseUrl);
		await eventually(
			async () => fake.hits.length,
			(count) => count > 0,
			20_000,
		);
		assert.ok(fake.hits.every(({ userAgent }) => userAgent?.startsWith("pi/")));
		assert.ok(
			(await fetches()).every((url) => url.startsWith(fake.baseUrl)),
			"the log sees them, and only them",
		);
	});

	it("leave nothing with P3_CATALOG_URL off: no request to pi.dev or anywhere", async (t) => {
		const fetches = await launched(t, "off");
		// An absence: the types' catalogs start with the server, so a while after it is ready is when a request would be.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.deepEqual(await fetches(), []);
	});
});
