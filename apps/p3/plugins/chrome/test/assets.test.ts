// Elanor's files the page links (`src/server.ts`, `elanorAssets`): a font's stylesheet, a font file it names, the
// font's license and the brand's tokens answer 200 with their content types, to anyone (the owner link's page links
// them before a sign-in), and the page links them before its own stylesheets.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";

describe("Elanor's files", () => {
	let t: TestServer;
	before(async () => {
		t = await testServer({}, context);
	});
	after(() => t.close(context));

	/** `path` fetched without a sign-in. */
	const get = (path: string) => fetch(`http://127.0.0.1:${t.port}${path}`);

	it("serves a font's stylesheet, a font file it names and its license, to anyone", async () => {
		const css = await get("/fonts/elanor/mallos-serif.css");
		assert.equal(css.status, 200);
		assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
		const text = await css.text();
		const font = /url\('\.\/(files\/[^']+\.woff2)'\)/.exec(text)?.[1];
		assert.ok(font !== undefined, "the stylesheet names a woff2 file");
		const file = await get(`/fonts/elanor/${font}`);
		assert.equal(file.status, 200);
		assert.equal(file.headers.get("content-type"), "font/woff2");
		assert.ok((await file.arrayBuffer()).byteLength > 1000);
		const license = await get("/fonts/elanor/licenses/mallos-serif.txt");
		assert.equal(license.status, 200);
		assert.equal(license.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.match(await license.text(), /license/i);
	});

	it("serves the brand's tokens", async () => {
		const tokens = await get("/tokens.css");
		assert.equal(tokens.status, 200);
		assert.equal(tokens.headers.get("content-type"), "text/css; charset=utf-8");
		assert.match(await tokens.text(), /--semantic-color-background-canvas:/);
	});

	it("links them in the page before its own stylesheets", async () => {
		const page = await fetch(`http://127.0.0.1:${t.port}/coding`, { headers: { cookie: await t.cookie(context) } });
		assert.equal(page.status, 200);
		const html = await page.text();
		const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
		assert.deepEqual(links.slice(0, 3), [
			"/fonts/elanor/mallos-serif.css",
			"/fonts/elanor/commit-mono.css",
			"/tokens.css",
		]);
		assert.ok(html.includes('<div id="root"></div>'));
	});
});
