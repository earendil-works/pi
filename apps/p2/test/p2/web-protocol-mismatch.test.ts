// A page whose server speaks another link protocol: reload only when the server is newer. When the server is older
// (Vite already serves a pull's new code while the old server still runs), keep reconnecting instead of reloading in
// a loop that ends on an error page once the restart closes the port.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { Browser, browserTests } from "./browser.ts";
import { binaryCodec, type Fixture, poll, startFixture } from "./helpers.ts";

/**
 * Stands in for the server on `port`: serves a plain page and answers every Chord link's hello with a hello of the
 * page's protocol plus `offset` (Chord's binary codec), then closes it.
 */
function fakeServer(port: number, offset: () => number): Promise<{ server: Server; links: () => number }> {
	let links = 0;
	const sockets = new WebSocketServer({ noServer: true });
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html" });
		response.end("<!doctype html><title>fake</title>");
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
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, links: () => links })));
}

describe("web page and link protocol versions", { skip: !browserTests }, () => {
	let fixture: Fixture | undefined;
	let browser: Browser | undefined;
	let fake: Server | undefined;
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await new Promise((resolve) => (fake ? fake.close(resolve) : resolve(undefined)));
	});

	it("keeps reconnecting to an older server and reloads for a newer one", async () => {
		fixture = await startFixture({ web: true });
		const port = fixture.server.port;
		browser = await Browser.start();
		await browser.open(`http://127.0.0.1:${port}/`);
		await browser.wait(`document.querySelector('.app, .hero') !== null`);
		await browser.evaluate(`window.__mark = 1`);

		await fixture.close();
		fixture = undefined;
		let offset = -1;
		const started = await fakeServer(port, () => offset);
		fake = started.server;

		// An older server: several links refused, the page stays (no reload loop).
		const current = browser;
		await poll(async () => started.links() >= 3 || (await current.evaluate(`window.__mark !== 1`)), 20_000);
		assert.equal(await browser.evaluate<number | undefined>(`window.__mark`), 1, "the page reloaded");

		// A newer server: this page is outdated and reloads.
		offset = 1;
		await browser.wait(`window.__mark === undefined && document.title === 'fake'`);
	});
});
