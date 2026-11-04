// The server serves the web UI (one content-named esbuild bundle) and the chord2 WebSocket to the localhost owner only.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, request } from "node:http";
import { after, before, describe, it } from "node:test";
import { WebSocket as NodeWebSocket } from "ws";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, startFixture, webBundle } from "./helpers.ts";

function get(
	port: number,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers }, (response) => {
			let body = "";
			response.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("web host", () => {
	let fixture: Fixture;
	before(async () => {
		// share.test stands for a remote address (a tunnel, a proxy): requests from it are signed out without a cookie.
		fixture = await startFixture({ web: true, allowedHosts: ["share.test"] });
	});
	after(async () => {
		await fixture?.close();
	});

	it("serves the app page naming the current bundle, whose files never change", async () => {
		const port = fixture.server.port;
		const bundle = await webBundle(port);
		assert.equal((await get(port, "/__p2_web")).headers["cache-control"], "no-store");
		for (const path of ["/", "/s/0b9f3a52-6a39-4d43-9d55-1a0f4ea4f1a2"]) {
			const page = await get(port, path);
			assert.equal(page.status, 200);
			assert(page.body.includes(`data-web-version="${bundle.version}"`), page.body);
			assert(page.body.includes(`<script type="module" src="${bundle.script}"></script>`), page.body);
			assert(page.body.includes(`<link rel="stylesheet" href="${bundle.style}" />`), page.body);
		}
		const script = await get(port, bundle.script);
		assert.equal(script.status, 200);
		assert.match(String(script.headers["content-type"]), /^text\/javascript/);
		assert.equal(script.headers["cache-control"], "private, max-age=31536000, immutable");
	});

	it("sends a CSP refusing every framer, and the loopback owner only to its own origin's requests", async () => {
		const port = fixture.server.port;
		const page = await get(port, "/");
		assert.equal(page.status, 200);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /frame-ancestors 'none'$/);
		const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
		assert.ok(nonce, csp);
		assert.equal(page.headers["x-frame-options"], "DENY");
		// The page's own inline script (the theme) carries the nonce.
		for (const script of page.body.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g))
			assert.match(script[0], new RegExp(`nonce="${nonce}"`), script[0]);
		// Another site's page, link, frame or fetch, or another local port (same-site), is not the device owner.
		for (const headers of [
			{ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" },
			{ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" },
			{ "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "iframe" },
			{ "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "empty" },
		]) {
			for (const path of ["/", (await webBundle(port)).script, "/__p2_web", "/__p2_tui", "/__p2_dev"]) {
				const response = await get(port, path, headers);
				assert.ok(response.status === 401 || response.status === 403, `${path} ${JSON.stringify(headers)}`);
				assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'$/);
			}
		}
		// File routes check the same principal: no owner download or workspace read for another site.
		for (const path of ["/download?session=x&id=y", "/workspace-file?session=x&conversation=1&path=a"])
			assert.notEqual((await get(port, path, { "Sec-Fetch-Site": "cross-site" })).status, 200, path);
		// The owner's own requests: typed or bookmarked (none), its pages and modules (same-origin).
		assert.equal((await get(port, "/", { "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "document" })).status, 200);
		assert.equal(
			(
				await get(port, (await webBundle(port)).script, {
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-Dest": "script",
				})
			).status,
			200,
		);
	});

	it("serves the installable app's files without signing in, not to another site, and nothing else", async () => {
		// Adding the app to a home screen fetches them without the page's cookies: Chrome loads the manifest without
		// credentials, iOS often fetches the touch icon on its own (no browser site headers). A remote address without
		// a cookie is signed out.
		const port = fixture.server.port;
		const remote = { Host: "share.test" };
		const manifest = await get(port, "/manifest.webmanifest", { ...remote, "Sec-Fetch-Site": "same-origin" });
		assert.equal(manifest.status, 200);
		const icons = (JSON.parse(manifest.body) as { icons: { src: string }[] }).icons.map((icon) => icon.src);
		for (const path of [...icons, "/icons/apple-touch-icon.png", "/apple-touch-icon.png", "/icons/favicon.svg"]) {
			const icon = await get(port, path, remote);
			assert.equal(icon.status, 200, path);
			assert.match(String(icon.headers["content-type"]), /^image\//, path);
			assert.equal(icon.headers["cache-control"], "public, max-age=86400", path);
		}
		const worker = await get(port, "/sw.js", remote);
		assert.equal(worker.status, 200);
		assert.equal(worker.headers["cache-control"], "no-cache");
		// Nothing else without signing in.
		for (const path of ["/", "/__p2_web", "/icons/other.png", "/manifest.webmanifest/x", "/__proto__"])
			assert.notEqual((await get(port, path, remote)).status, 200, path);
		// Another site's page may not load them: an icon that loads would tell it a p2 runs at that address.
		for (const headers of [
			{ ...remote, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "image" },
			{ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "image" },
			{ "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "image" },
		])
			assert.notEqual((await get(port, "/icons/icon-192.png", headers)).status, 200, JSON.stringify(headers));
	});

	it("refuses another site's WebSocket even with a matching Origin", async () => {
		const outcome = (headers: Record<string, string>) =>
			new Promise<string>((resolve) => {
				const socket = new NodeWebSocket(`ws://127.0.0.1:${fixture.server.port}/chord`, { headers });
				socket.once("open", () => {
					socket.close();
					resolve("open");
				});
				socket.once("error", () => resolve("refused"));
			});
		const origin = `http://127.0.0.1:${fixture.server.port}`;
		assert.equal(await outcome({ Origin: origin, "Sec-Fetch-Site": "cross-site" }), "refused");
		assert.equal(await outcome({ Origin: origin, "Sec-Fetch-Site": "same-site" }), "refused");
		assert.equal(await outcome({ Origin: origin, "Sec-Fetch-Site": "same-origin" }), "open");
	});

	it(
		"in a browser: the app runs under its CSP, and another origin cannot frame it",
		{ skip: !browserTests, timeout: 60_000 },
		async () => {
			const framer = createServer((_request, response) => {
				response.writeHead(200, { "Content-Type": "text/html" });
				response.end(`<iframe id="app" src="http://127.0.0.1:${fixture.server.port}/"></iframe>`);
			});
			await new Promise<void>((resolve) => framer.listen(0, "127.0.0.1", resolve));
			const framerPort = (framer.address() as { port: number }).port;
			const browser = await Browser.start();
			try {
				await browser.call("Page.addScriptToEvaluateOnNewDocument", {
					source:
						"window.cspViolations=[];document.addEventListener('securitypolicyviolation',(e)=>window.cspViolations.push(e.violatedDirective+' '+e.blockedURI))",
				});
				await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
				await browser.wait("document.querySelector('.composer textarea') && !document.querySelector('.offline')");
				assert.deepEqual(await browser.evaluate("window.cspViolations"), []);
				// A page of another origin (another port, same site) framing the app: Chromium refuses to render it.
				await browser.open(`http://127.0.0.1:${framerPort}/`);
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const tree = (await browser.call("Page.getFrameTree")) as {
					frameTree: { childFrames?: { frame: { url: string; unreachableUrl?: string } }[] };
				};
				const child = tree.frameTree.childFrames?.[0]?.frame;
				assert.ok(child, "the framer has its iframe");
				assert.ok(
					child.url.startsWith("chrome-error:") || child.unreachableUrl !== undefined,
					JSON.stringify(child),
				);
			} finally {
				await browser.close();
				await new Promise<void>((resolve) => framer.close(() => resolve()));
			}
		},
	);

	it("refuses other hosts and origins", async () => {
		const forged = await get(fixture.server.port, "/", { Host: "evil.example" });
		assert.equal(forged.status, 403);
		const forwarded = await get(fixture.server.port, "/", { "X-Forwarded-For": "1.2.3.4" });
		assert.equal(forwarded.status, 403);
		const socket = new NodeWebSocket(`ws://127.0.0.1:${fixture.server.port}/chord`, {
			headers: { Origin: "http://evil.example" },
		});
		const outcome = await new Promise<string>((resolve) => {
			socket.once("open", () => resolve("open"));
			socket.once("error", () => resolve("refused"));
			socket.once("close", () => resolve("refused"));
		});
		assert.equal(outcome, "refused");
	});
});
