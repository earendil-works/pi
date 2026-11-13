// Browser: pages on Chord's web surface. A plugin's web change rolled out applies in the open page in place (no reload:
// the transcript's scroll and the other panes stay); a base change (the server's base bundle, answered here by CDP)
// reloads the page; a link naming another base is refused at once, telling the owner which device it was; a page the
// service worker started from its kept page while the server was down takes the changed plugin in place once the
// server is back. A user plugin's web facet (`stamp`) is the changed plugin. Fake provider, its own data directory and
// port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { LogNotices } from "../../plugins/logs/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import { type P2Server, startServer } from "../../src/hosts/server.ts";
import { LINK_CLIENTS, STALE_PAGE_CODE } from "../../src/runtime/stale-page.ts";
import { Browser, browserTests } from "./browser.ts";
import { clientHost, holdIn, type LocalOwner, localOwner, until, webAssets } from "./helpers.ts";

describe("pages on the web surface", { skip: !browserTests }, () => {
	const root = mkdtempSync(join(tmpdir(), "p2-surface-"));
	const dataDir = join(root, "data");
	let server: P2Server | undefined;
	let port = 0;
	let owner: LocalOwner;
	let browser: Browser;
	let session = "";

	/** Writes the `stamp` plugin's web facet: its setup sets `p2Mark` to `mark`, a change of it a new script. */
	const stamp = (mark: string) => {
		const dir = join(dataDir, "plugins", "stamp");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), '{ "name": "stamp", "private": true, "type": "module" }');
		writeFileSync(
			join(dir, "web.tsx"),
			`import { defineFacet } from "@p2/app/v1";\nexport default defineFacet(() => {\n\t(globalThis as { p2Mark?: string }).p2Mark = ${JSON.stringify(mark)};\n});\n`,
		);
	};
	const start = async () => {
		server = await startServer({ dataDir, port, fake: true, web: true });
		port = server.port;
	};
	const shows = (mark: string) => `window.p2Mark === ${JSON.stringify(mark)}`;

	before(async () => {
		stamp("one");
		await start();
		owner = await localOwner(server!);
		const host = clientHost(owner);
		try {
			const sessions = await holdIn(host, Sessions, {}, "owner");
			session = (await sessions.create({ cwd: root, title: "Surface" }, BACKGROUND_CONTEXT)).id;
			const chat = await holdIn(host, Chat, { session, conversation: 1 }, "participant");
			for (let index = 0; index < 6; index++) {
				const text = `line ${index} ${"to scroll through ".repeat(80)}`;
				await chat.send({ text, requestId: `fill-${index}` }, BACKGROUND_CONTEXT);
				await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: line ${index}`));
			}
			await (await holdIn(host, Views, { session }, "editor")).open({ kind: "changes" }, BACKGROUND_CONTEXT);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
		browser = await Browser.start();
		await browser.signIn(owner);
	});
	after(async () => {
		await browser?.close();
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("applies a plugin's web change in place: the transcript's scroll and the other panes stay", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${port}/s/${session}`);
		await browser.wait(`${shows("one")} && document.querySelector('.views-pane.kind-changes')`);
		const scroller = "document.querySelector('.scroller.transcript')";
		await browser.wait(`${scroller}?.scrollHeight > ${scroller}?.clientHeight * 2`);
		await browser.evaluate(`${scroller}.scrollTop = 400`);
		const scrolled = await browser.evaluate<number>(`${scroller}.scrollTop`);
		// Marks a remount or a reload would lose.
		await browser.evaluate(
			`window.__sameDocument = true; document.querySelector('.views-pane.kind-changes').dataset.kept = 'yes'; ${scroller}.dataset.kept = 'yes'`,
		);
		const before = await webAssets(port, { Cookie: owner.cookie });
		stamp("two");
		await server!.reload(["stamp"]);
		await browser.wait(shows("two"));
		const after = await webAssets(port, { Cookie: owner.cookie });
		assert.equal(after.base, before.base, "a plugin's change is no base change");
		assert.notEqual(after.plugins, before.plugins);
		assert.deepEqual(
			await browser.evaluate<unknown[]>(
				`[window.__sameDocument, document.querySelector('.views-pane.kind-changes').dataset.kept, ${scroller}.dataset.kept, ${scroller}.scrollTop]`,
			),
			[true, "yes", "yes", scrolled],
		);
	});

	it("reloads the page when the server's base bundle changed", async () => {
		await browser.open(`http://127.0.0.1:${port}/s/${session}`);
		await browser.wait(`${shows("two")} && document.querySelector('.composer textarea')`);
		await browser.evaluate("window.__sameDocument = true");
		// The page asks the server's base when it reconnects; here CDP answers another one once, after a restart.
		let answered = false;
		const changed = (raw: unknown) => {
			const message = JSON.parse(String(raw)) as { method?: string; params?: { requestId: string } };
			if (message.method !== "Fetch.requestPaused" || !message.params) return;
			const body = answered ? undefined : Buffer.from(JSON.stringify("0123456789abcdef")).toString("base64");
			answered = true;
			void browser.call(
				body === undefined ? "Fetch.continueRequest" : "Fetch.fulfillRequest",
				body === undefined
					? { requestId: message.params.requestId }
					: {
							requestId: message.params.requestId,
							responseCode: 200,
							responseHeaders: [{ name: "Content-Type", value: "application/json" }],
							body,
						},
			);
		};
		browser.socket.on("message", changed);
		await browser.call("Fetch.enable", { patterns: [{ urlPattern: "*/_chord/web/base" }] });
		try {
			await server!.close();
			await start();
			await browser.wait(
				`!window.__sameDocument && ${shows("two")} && document.querySelector('.composer textarea')`,
			);
			assert.equal(answered, true);
		} finally {
			await browser.call("Fetch.disable");
			browser.socket.off("message", changed);
		}
	});

	it("refuses a link naming another base or nothing at once, and tells the owner which device", async () => {
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait("document.documentElement.dataset.webVersion");
		const closeOf = (query: string) =>
			browser.evaluate<number>(`new Promise((resolve) => {
				const socket = new WebSocket('ws://' + location.host + '/chord${query}');
				socket.onclose = (event) => resolve(event.code);
				setTimeout(() => resolve(-1), 5000);
			})`);
		const host = clientHost(owner);
		try {
			const notices = await holdIn(host, LogNotices, {}, "owner");
			/** The owner's newest notice about stale pages once it matches `pattern`. */
			const told = (pattern: RegExp) =>
				until(notices.notices, (value) =>
					value.some((each) => each.source === "stale-pages" && pattern.test(each.message)),
				);
			assert.equal(await closeOf("?web=0123abcd"), STALE_PAGE_CODE);
			await told(/web bundle 0123abcd.*the owner \(local\).*Chrome.*from 127\.0\.0\.1 \(WebSocket \/chord\)/);
			// A page from before pages named their base names nothing: refused too. Other clients name themselves.
			assert.equal(await closeOf(""), STALE_PAGE_CODE);
			await told(/web bundle unnamed: from before/);
			assert.equal(await closeOf("?client=nobody"), STALE_PAGE_CODE);
			for (const client of LINK_CLIENTS) assert.equal(await closeOf(`?client=${client}`), -1, client);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("takes a changed plugin in place on a page the service worker started while the server was down", async () => {
		// The worker keeps this version's page and the files it names.
		await browser.open(`http://127.0.0.1:${port}/s/${session}`);
		await browser.wait(`(async () => {
			const shell = await (await caches.open('p2-app-shell')).match('/');
			if (!shell) return false;
			const script = /src="(\\/_chord\\/web\\/base\\.[^"]+)"/.exec(await shell.text())?.[1];
			return Boolean(script && (await caches.match(script)));
		})()`);
		await server!.close();
		server = undefined;
		await browser.open(`http://127.0.0.1:${port}/s/${session}`);
		await browser.wait(`${shows("two")} && document.querySelector('.offline')`);
		await browser.evaluate("window.__sameDocument = true");
		stamp("three");
		await start();
		await browser.wait(`${shows("three")} && window.__sameDocument === true && !document.querySelector('.offline')`);
	});
});
