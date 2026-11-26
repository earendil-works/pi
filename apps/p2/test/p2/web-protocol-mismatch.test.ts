// A page whose server speaks another link protocol. A page p2 serves asks the server's base bundle before each
// reconnect: while it is unknown (a server still building it) the page keeps reconnecting instead of reloading in a
// loop; another one means the page is outdated, and it reloads (the server serves its own bundle, older or newer). A
// Radius Cloud Brain page (static: it asks no base bundle) refused by a newer server stops reconnecting and says it is
// outdated. A server refusing an outdated client's hello logs it at most once a minute and raises no owner notice.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { processLogs } from "../../src/runtime/logs.ts";
import { clientLinkPath } from "../../src/runtime/stale-page.ts";
import { Browser, browserTests } from "./browser.ts";
import { binaryCodec, type Fixture, poll, startFixture } from "./helpers.ts";

/** Opens a link to `fixture`'s server as an outdated client: its hello names the server's protocol minus one. */
function outdatedHello(fixture: Fixture): Promise<void> {
	const socket = new WebSocket(`ws://127.0.0.1:${fixture.server.port}${clientLinkPath("script")}`, {
		headers: { Cookie: fixture.owner.cookie },
	});
	socket.once("message", (data) => {
		const hello = binaryCodec.decode(new Uint8Array(data as Buffer));
		if (hello.kind === "hello") socket.send(binaryCodec.encode({ ...hello, protocol: hello.protocol - 1 }));
	});
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

/** A file the fake server serves at a path, if any. */
type Files = (
	path: string,
) => Promise<{ readonly status?: number; readonly type: string; readonly body: Buffer | string } | undefined>;

/**
 * Stands in for the server on `port` (0: any): serves `files`, else a plain page, and answers every Chord link's hello
 * with a hello of the page's protocol plus `offset` (Chord's binary codec), then closes it.
 */
function fakeServer(
	port: number,
	offset: () => number,
	files: Files = async () => undefined,
): Promise<{ server: Server; port: number; links: () => number }> {
	let links = 0;
	const sockets = new WebSocketServer({ noServer: true });
	const server = createServer((request, response) => {
		void files(new URL(request.url ?? "/", "http://fake").pathname).then((file) => {
			response.writeHead(file?.status ?? 200, { "content-type": file?.type ?? "text/html" });
			response.end(file?.body ?? "<!doctype html><title>fake</title>");
		});
	});
	server.on("upgrade", (request, socket, head) => {
		if (!request.url?.startsWith("/chord")) return socket.destroy();
		sockets.handleUpgrade(request, socket, head, (ws) => {
			links++;
			ws.once("message", (data) => {
				// What a host of another version does: its own hello, which the page refuses.
				const hello = binaryCodec.decode(new Uint8Array(data as Buffer));
				if (hello.kind !== "hello") return ws.close();
				ws.send(binaryCodec.encode({ ...hello, protocol: hello.protocol + offset() }), () => ws.close(1000));
			});
		});
	});
	return new Promise((resolve) =>
		server.listen(port, "127.0.0.1", () =>
			resolve({ server, port: (server.address() as AddressInfo).port, links: () => links }),
		),
	);
}

const APP = fileURLToPath(new URL("../../", import.meta.url));
const SHA = "0".repeat(40);

/** The Cloud Brain build (scripts/cloud-bundle.ts) in `out`, served as Radius serves it, its Chord URL `chordUrl`. */
async function cloudFiles(out: string, chordUrl: () => string): Promise<Files> {
	await promisify(execFile)(process.execPath, ["--import", "./src/source.ts", "scripts/cloud-bundle.ts", SHA, out], {
		cwd: APP,
		maxBuffer: 16 * 1024 * 1024,
	});
	const manifest = JSON.parse(await readFile(join(out, SHA, "manifest.json"), "utf8")) as {
		script: string;
		stylesheets: string[];
	};
	const prefix = `/pi/ui/${SHA}/`;
	return async (path) => {
		if (!path.startsWith(prefix)) return undefined;
		const file = path.slice(prefix.length);
		if (file === "index.html")
			return {
				type: "text/html",
				body: `<!doctype html><html><head><meta charset="utf-8">${manifest.stylesheets
					.map((style) => `<link rel="stylesheet" href="${prefix}${style}">`)
					.join("")}</head><body><div id="root" data-pi-bootstrap='${JSON.stringify({
					chordUrl: chordUrl(),
				})}'></div><script type="module" src="${prefix}${manifest.script}"></script></body></html>`,
			};
		const type = file.endsWith(".js")
			? "text/javascript"
			: file.endsWith(".css")
				? "text/css"
				: "application/octet-stream";
		return { type, body: await readFile(join(out, SHA, file)) };
	};
}

describe("web page and link protocol versions", { skip: !browserTests }, () => {
	let fixture: Fixture | undefined;
	let browser: Browser | undefined;
	let fake: Server | undefined;
	let cloud: Server | undefined;
	const out = mkdtempSync(join(tmpdir(), "p2-cloud-"));
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await new Promise((resolve) => (fake ? fake.close(resolve) : resolve(undefined)));
		await new Promise((resolve) => (cloud ? cloud.close(resolve) : resolve(undefined)));
		await rm(out, { recursive: true, force: true });
	});

	it("keeps reconnecting while the server's base bundle is unknown and reloads once it is another", async () => {
		fixture = await startFixture({ web: true });
		const port = fixture.server.port;
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait(`document.querySelector('.app, .hero') !== null`);
		await browser.evaluate(`window.__mark = 1`);

		await fixture.close();
		fixture = undefined;
		let base: string | undefined;
		const started = await fakeServer(
			port,
			() => 1,
			async (path) =>
				path !== "/_chord/web/base"
					? undefined
					: base === undefined
						? { status: 503, type: "text/plain", body: "" }
						: { type: "application/json", body: JSON.stringify(base) },
		);
		fake = started.server;

		// The base unknown: several links refused, the page stays (no reload loop).
		const current = browser;
		await poll(async () => started.links() >= 3 || (await current.evaluate(`window.__mark !== 1`)), 20_000);
		assert.equal(await browser.evaluate<number | undefined>(`window.__mark`), 1, "the page reloaded");

		// Another base: this page is outdated and reloads.
		base = "another";
		await browser.wait(`window.__mark === undefined && document.title === 'fake'`);
	});

	it("a Cloud Brain page refused by a newer server stops reconnecting and says it is outdated", async () => {
		browser ??= await Browser.start();
		let port = 0;
		const started = await fakeServer(0, () => 1, await cloudFiles(out, () => `ws://127.0.0.1:${port}/chord`));
		cloud = started.server;
		port = started.port;
		await browser.open(`http://127.0.0.1:${port}/pi/ui/${SHA}/index.html`);
		await browser.wait(`document.querySelector('[data-testid="page-outdated"]') !== null`);
		// No more attempts: the connection loop waits up to 5 s between them.
		const links = started.links();
		await new Promise((resolve) => setTimeout(resolve, 6000));
		assert.equal(started.links(), links, "the page kept reconnecting");
	});
});

describe("a server refusing an outdated client's hello", () => {
	it("logs it at most once a minute and raises no owner notice", async (t) => {
		const fixture = await startFixture({});
		t.after(() => fixture.close());
		const logged = t.mock.method(console, "error", () => {});
		await outdatedHello(fixture);
		await outdatedHello(fixture);
		const protocol = logged.mock.calls.filter(
			(call) => (call.arguments[1] as { kind?: string })?.kind === "protocol_error",
		);
		assert.equal(protocol.length, 1, JSON.stringify(logged.mock.calls.map((call) => String(call.arguments[1]))));
		assert.match(
			String((protocol[0]!.arguments[1] as { error: unknown }).error),
			/handshake: protocol \d+, this host speaks/,
		);
		assert.deepEqual(
			processLogs.notices().filter((notice) => notice.message.includes("protocol_error")),
			[],
		);
	});
});
