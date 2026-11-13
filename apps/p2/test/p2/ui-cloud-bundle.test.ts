// Browser: the Radius Cloud Brain build (scripts/cloud-bundle.ts) makes a working page. The build's files are served
// as Radius serves them (under /pi/ui/<sha>/, here on the brain's own origin through Chromium's request interception,
// as the relay presents both on one origin), in a page naming the brain's Chord URL in `#root`'s `data-pi-bootstrap`:
// the app renders, connects, and never asks for the web surface's files (a static page). Fake provider.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, startFixture } from "./helpers.ts";

const APP = fileURLToPath(new URL("../../", import.meta.url));
const SHA = "0".repeat(40);

describe("the Cloud Brain page", { skip: !browserTests }, () => {
	const out = mkdtempSync(join(tmpdir(), "p2-cloud-"));
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		await promisify(execFile)(
			process.execPath,
			["--import", "./src/source.ts", "scripts/cloud-bundle.ts", SHA, out],
			{ cwd: APP, maxBuffer: 16 * 1024 * 1024 },
		);
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await rm(out, { recursive: true, force: true });
	});

	it("renders and connects from its one script and stylesheet, loading nothing of the web surface", async () => {
		const origin = `http://127.0.0.1:${fixture.server.port}`;
		const manifest = JSON.parse(await readFile(join(out, SHA, "manifest.json"), "utf8")) as {
			script: string;
			stylesheets: string[];
		};
		const prefix = `/pi/ui/${SHA}/`;
		const page = `<!doctype html><html><head><meta charset="utf-8">${manifest.stylesheets
			.map((style) => `<link rel="stylesheet" href="${prefix}${style}">`)
			.join("")}</head><body><div id="root" data-pi-bootstrap='${JSON.stringify({
			chordUrl: `ws://127.0.0.1:${fixture.server.port}/chord`,
		})}'></div><script type="module" src="${prefix}${manifest.script}"></script></body></html>`;
		const requested: string[] = [];
		const serve = (raw: unknown) => {
			const message = JSON.parse(String(raw)) as {
				method?: string;
				params?: { requestId: string; request: { url: string } };
			};
			if (message.method !== "Fetch.requestPaused" || !message.params) return;
			const { requestId, request } = message.params;
			const path = new URL(request.url).pathname;
			requested.push(path);
			if (!path.startsWith(prefix)) return void browser.call("Fetch.continueRequest", { requestId });
			const file = path.slice(prefix.length);
			void (async () => {
				const body = file === "index.html" ? Buffer.from(page) : await readFile(join(out, SHA, file));
				const type = file.endsWith(".js")
					? "text/javascript"
					: file.endsWith(".css")
						? "text/css"
						: file.endsWith(".html")
							? "text/html"
							: "application/octet-stream";
				await browser.call("Fetch.fulfillRequest", {
					requestId,
					responseCode: 200,
					responseHeaders: [{ name: "Content-Type", value: type }],
					body: body.toString("base64"),
				});
			})();
		};
		browser.socket.on("message", serve);
		await browser.call("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*` }] });
		try {
			await browser.metrics(1280, 900);
			await browser.open(`${origin}${prefix}index.html`);
			await browser.wait("document.querySelector('.app') && !document.querySelector('.offline')");
			assert.equal(
				requested.some((path) => path.startsWith("/_chord/web/")),
				false,
				requested.join("\n"),
			);
		} finally {
			await browser.call("Fetch.disable");
			browser.socket.off("message", serve);
		}
	});
});
