// Public-origin pages (owner and guest, dev mode included) must never reach the visitor's local network, and load only
// the page's own bundle and `/chord`. All hosts/data/providers are disposable.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Devices } from "../../plugins/devices/contract.ts";
import { PROXY_MARKER_HEADER } from "../../plugins/proxy-marker/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, http, startFixture, until } from "./helpers.ts";

function localNetwork(url: string): boolean {
	const host = new URL(url).hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (isIP(host) === 6)
		return host === "::1" || host === "::" || /^f[cd]|^fe[89ab]/.test(host) || host.startsWith("::ffff:");
	if (isIP(host) !== 4) return false;
	const [a, b] = host.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

describe("clients through a public-origin proxy", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let directory: string;
	let proxy: ReturnType<typeof createServer>;
	let origin: string;
	let publicHost: string;
	let guestLink: string;
	let ownerCookie: string;
	let session: string;
	const sockets = new Set<Duplex>();
	const browsers: Browser[] = [];
	const startBrowser = async (cookie?: string) => {
		const browser = await Browser.start([
			"--incognito",
			"--ignore-certificate-errors",
			"--no-proxy-server",
			"--host-resolver-rules=MAP p2.network.test 127.0.0.1",
		]);
		browsers.push(browser);
		await browser.call("Network.enable");
		if (cookie) {
			const separator = cookie.indexOf("=");
			await browser.call("Network.setCookie", {
				name: cookie.slice(0, separator),
				value: cookie.slice(separator + 1),
				url: origin,
				secure: true,
				httpOnly: true,
			});
		}
		const requests: string[] = [];
		const websockets: string[] = [];
		browser.socket.on("message", (raw) => {
			const event = JSON.parse(raw.toString()) as {
				method?: string;
				params?: { url?: string; request?: { url: string } };
			};
			if (event.method === "Network.requestWillBeSent" && event.params?.request)
				requests.push(event.params.request.url);
			if (event.method === "Network.webSocketCreated" && event.params?.url) websockets.push(event.params.url);
		});
		return { browser, requests, websockets };
	};
	const assertPublicOnly = (requests: string[], websockets: string[]) => {
		assert.deepEqual(
			[...requests, ...websockets].filter(localNetwork),
			[],
			"a client attempted local-network access",
		);
		for (const url of [...requests, ...websockets].filter((url) => !url.startsWith("data:")))
			assert.equal(new URL(url).host, publicHost, "requests must use the page origin");
		// The app's sockets are its Chord link only (no dev-server socket).
		for (const url of websockets) assert.equal(new URL(url).pathname, "/chord");
	};
	before(async () => {
		directory = mkdtempSync(join(tmpdir(), "p2-dev-network-"));
		const key = join(directory, "key.pem");
		const cert = join(directory, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=p2.network.test",
			],
			{ stdio: "ignore" },
		);
		proxy = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, response) => {
			const upstream = request(
				{
					hostname: "127.0.0.1",
					port: fixture.server.port,
					path: incoming.url,
					method: incoming.method,
					headers: { ...incoming.headers, [PROXY_MARKER_HEADER]: "1" },
				},
				(result) => {
					response.writeHead(result.statusCode ?? 502, result.headers);
					result.pipe(response);
				},
			);
			upstream.on("error", () => {
				response.writeHead(502);
				response.end();
			});
			incoming.pipe(upstream);
		});
		proxy.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		proxy.on("upgrade", (incoming, socket, head) => {
			const upstream = connect(fixture.server.port, "127.0.0.1", () => {
				const headers = { ...incoming.headers, [PROXY_MARKER_HEADER]: "1" };
				upstream.write(
					`${incoming.method} ${incoming.url} HTTP/1.1\r\n${Object.entries(headers)
						.map(([name, value]) => `${name}: ${value}\r\n`)
						.join("")}\r\n`,
				);
				if (head.length) upstream.write(head);
				socket.pipe(upstream).pipe(socket);
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
			socket.on("close", () => upstream.destroy());
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		assert(address && typeof address === "object");
		publicHost = `p2.network.test:${address.port}`;
		origin = `https://${publicHost}`;
		fixture = await startFixture({ web: true, dev: true, allowedHosts: [publicHost] });
		const owner = fixture.browser();
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Network fixture" }, BACKGROUND_CONTEXT)
		).id;
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		assert(links?.[0]);
		guestLink = links[0].url;
		const headers = {
			Host: publicHost,
			Origin: origin,
			[PROXY_MARKER_HEADER]: "1",
			"Content-Type": "application/json",
		};
		const { token } = await owner.hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT);
		const signed = await http(fixture.server.port, "/owner/claim", {
			method: "POST",
			headers,
			body: JSON.stringify({ token }),
		});
		assert.equal(signed.status, 200);
		ownerCookie = String(signed.headers["set-cookie"]).split(";")[0];
	});
	after(async () => {
		for (const browser of browsers) await browser.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => proxy?.close(() => resolve()));
		await fixture?.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it("a guest loads its styled app without local-network requests", async () => {
		const { browser, requests, websockets } = await startBrowser();
		await browser.open(guestLink);
		await browser.wait('document.querySelector("#join #name")');
		await browser.evaluate('document.querySelector("#name").value="Browser guest"');
		await browser.click("#join button");
		await browser.wait(
			`document.querySelector('nav[aria-label="Shared session"]') && !document.querySelector('.offline')`,
		);
		// Let the version poll and any late request happen inside the observed window.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assertPublicOnly(requests, websockets);
		assert(requests.some((url) => new URL(url).pathname.startsWith("/__p2_web/app-")));
		assert.equal(await browser.evaluate<string>('getComputedStyle(document.querySelector(".app")).display'), "flex");
	});
	it("a signed-out visitor gets only the sign-in page, never the app or a connection", async () => {
		const { browser, requests, websockets } = await startBrowser();
		await browser.open(origin);
		await browser.wait('document.querySelector("#sign-in #token")');
		assertPublicOnly(requests, websockets);
		assert.equal(websockets.length, 0);
		assert(!requests.some((url) => new URL(url).pathname.startsWith("/__p2_web/")));
	});
	it("a proxied owner loads the app with same-origin requests only, Providers included", async () => {
		const { browser, requests, websockets } = await startBrowser(ownerCookie);
		await browser.metrics(1280, 900);
		await browser.open(origin);
		await browser.wait('document.querySelector(".composer textarea") && !document.querySelector(".offline")');
		// Remote owners (not only the device) may sign in to model providers.
		await browser.wait(
			'[...document.querySelectorAll("button")].some((button) => button.textContent === "Providers")',
		);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assertPublicOnly(requests, websockets);
		assert(websockets.some((url) => new URL(url).pathname === "/chord"));
	});
});
