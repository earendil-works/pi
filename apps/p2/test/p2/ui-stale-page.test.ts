// Browser: every open page ends up on the server's current web bundle. A page's link names its bundle version; the
// server refuses a link naming another version at once, telling the owner which device it was, and the page reloads. Covered: a raw stale link; a page open while the server restarts with a changed
// bundle (reporting itself hidden, as a background tab or a tablet's sleeping browser does); a page the service worker
// started from its kept older page while the server was down. A user plugin's web facet (`stamp`) changes the bundle
// between server runs. Fake provider, its own data directory and port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { LogNotices } from "../../plugins/logs/contract.ts";
import { type P2Server, startServer } from "../../src/hosts/server.ts";
import { STALE_PAGE_CODE } from "../../src/runtime/stale-page.ts";
import { Browser, browserTests } from "./browser.ts";
import { clientHost, holdIn, http, type LocalOwner, localOwner, until } from "./helpers.ts";

/** Makes the page say it is hidden from its first script on: the background tab's case. */
const HIDDEN = `Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { get: () => true });`;

describe("stale pages", { skip: !browserTests }, () => {
	const root = mkdtempSync(join(tmpdir(), "p2-stale-"));
	const dataDir = join(root, "data");
	let server: P2Server | undefined;
	let port = 0;
	let owner: LocalOwner;
	let browser: Browser;

	/** Writes the `stamp` plugin's web facet: a different `mark` is a different web bundle. */
	const stamp = (mark: string) => {
		const dir = join(dataDir, "plugins", "stamp");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), '{ "name": "stamp", "private": true, "type": "module" }');
		writeFileSync(
			join(dir, "web.tsx"),
			`import { defineFacet } from "@p2/app/v1";\nexport const MARK = ${JSON.stringify(mark)};\nexport default defineFacet(() => { (globalThis as { p2Mark?: string }).p2Mark = MARK; });\n`,
		);
	};
	const start = async () => {
		server = await startServer({ dataDir, port, fake: true, web: true });
		port = server.port;
	};
	/** The server's current web bundle version. */
	const current = async (): Promise<string> =>
		(JSON.parse((await http(port, "/__p2_web", { headers: { Cookie: owner.cookie } })).body) as { version: string })
			.version;
	const version = () => browser.evaluate<string>("document.documentElement.dataset.webVersion ?? ''");

	before(async () => {
		stamp("one");
		await start();
		owner = await localOwner(server!);
		browser = await Browser.start();
		await browser.signIn(owner);
	});
	after(async () => {
		await browser?.close();
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses a link naming another bundle at once, and tells the owner which device", async () => {
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait("document.documentElement.dataset.webVersion");
		const closeOf = (query: string) =>
			browser.evaluate<number>(`new Promise((resolve) => {
				const socket = new WebSocket('ws://' + location.host + '/chord${query}');
				socket.onclose = (event) => resolve(event.code);
				setTimeout(() => resolve(-1), 5000);
			})`);
		assert.equal(await closeOf("?web=0123abcd"), STALE_PAGE_CODE);
		// A link naming no version (the TUI, a Cloud Brain page) is not asked.
		assert.equal(await closeOf(""), -1);
		// The page's own link (its current version) is accepted: the page shows no offline state.
		assert.equal(await browser.evaluate<boolean>("Boolean(document.querySelector('.offline'))"), false);
		const host = clientHost(owner);
		try {
			const notices = await holdIn(host, LogNotices, {}, "owner");
			const [notice] = await until(notices.notices, (value) => value.some((each) => each.source === "stale-pages"));
			assert.match(
				notices.notices.value.find((each) => each.source === "stale-pages")?.message ?? String(notice),
				/web bundle 0123abcd.*the owner \(local\).*Chrome.*from 127\.0\.0\.1 \(WebSocket \/chord\)/,
			);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("reloads a page left open (hidden) while the server restarts with a changed bundle", async () => {
		const marker = await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: HIDDEN });
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait("document.documentElement.dataset.webVersion && window.p2Mark === 'one'");
		const before = await version();
		await browser.evaluate("window.__sameDocument = true");
		await server!.close();
		stamp("two");
		await start();
		const next = await current();
		assert.notEqual(next, before);
		await browser.wait(
			`!window.__sameDocument && document.documentElement.dataset.webVersion === '${next}' && window.p2Mark === 'two'`,
		);
		await browser.call("Page.removeScriptToEvaluateOnNewDocument", marker as { identifier: string });
	});

	it("reloads a page the service worker started from its kept older page", async () => {
		// The worker keeps this version's page and bundle.
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait(`(async () => {
			const shell = await (await caches.open('p2-app-shell')).match('/');
			if (!shell) return false;
			const script = /src="(\\/__p2_web\\/[^"]+)"/.exec(await shell.text())?.[1];
			return Boolean(script && (await caches.match(script)));
		})()`);
		const kept = await version();
		// Server down: the app starts from the kept page, then the server comes back with a changed bundle.
		await server!.close();
		server = undefined;
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait(`document.documentElement.dataset.webVersion === '${kept}' && window.p2Mark === 'two'`);
		await browser.evaluate("window.__sameDocument = true");
		stamp("three");
		await start();
		const next = await current();
		await browser.wait(
			`!window.__sameDocument && document.documentElement.dataset.webVersion === '${next}' && window.p2Mark === 'three'`,
		);
	});
});
