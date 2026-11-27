// The catalog requests of p3's real command (`p3 server`, launched as its own process; Opus and Astra, rounds 1 and 2
// of the catalog): it asks the catalog server `P3_CATALOG_URL` names, and with the variable `off` (as every test's p3
// has it, `launch` and `offline` in `test/support.ts`, whatever the shell set) no catalog request leaves it, none to
// pi.dev either, and no type reports a failed one (the switch, not an address that fails).

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
 * p3's command launched on a fresh data directory with `catalog` as `P3_CATALOG_URL` (none: `off`), every `fetch` of
 * its process written down (its URL only, by a module Node loads first) and its standard error kept; stopped and
 * removed after the test. Answers the catalog requests it made so far, and its standard error.
 */
async function launched(t: TestContext, catalog: string | undefined) {
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
	// As if the shell named pi.dev: the test's own setting wins.
	const env = {
		...process.env,
		P3_CATALOG_URL: "https://pi.dev",
		NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`,
	};
	let stderr = "";
	const server = await launch(COMMAND, join(dir, "pi"), env, {
		...(catalog === undefined ? {} : { catalog }),
		stderr: (text) => {
			stderr += text;
		},
	});
	t.after(() => server.stop());
	const fetches = async () => (await readFile(log, "utf8")).split("\n").filter((url) => url.includes("/api/models/"));
	return { fetches, stderr: () => stderr };
}

describe("the command's catalog requests", () => {
	it("go to the catalog server P3_CATALOG_URL names", async (t) => {
		const fake = await fakePiDev();
		t.after(() => fake.close());
		const { fetches } = await launched(t, fake.baseUrl);
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

	it("leave nothing with P3_CATALOG_URL off, whatever the shell set: no request, no failure reported", async (t) => {
		const { fetches, stderr } = await launched(t, undefined);
		// An absence (testing.md 2): the types' catalogs start with the server, a request or a failure would come at once.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.deepEqual(await fetches(), []);
		assert.ok(!stderr().includes("catalog"), stderr());
	});
});
