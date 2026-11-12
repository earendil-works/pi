// Requests another site or another local port makes (Fetch Metadata `cross-site`/`same-site`; SameSite cookies do
// not separate ports) never authenticate by any credential, except top-level navigations to app pages, which load
// the app for the owner's cookie (SameSite=Lax sends it on those). Without a cookie such a navigation gets the sign-in
// page, which loads itself once more from p2's origin (a client may have dropped the cookie). Requests without Fetch
// Metadata (the TUI, scripts) are unaffected; Radius-relayed ones are covered in radius.test.ts.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, http, poll, startFixture, until } from "./helpers.ts";

const NO_CORS = { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" };
const NAVIGATE = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };

const cookieOf = (headers: Record<string, string | string[] | undefined>, name: string): string =>
	[headers["set-cookie"] ?? []]
		.flat()
		.map((cookie) => cookie.split(";")[0]!)
		.find((cookie) => cookie.startsWith(`${name}=`)) ?? "";

/** Status of a WebSocket upgrade with these headers (101 when accepted). */
function upgrade(port: number, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, { headers });
		socket.on("open", () => {
			socket.close();
			resolve(101);
		});
		socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
		socket.on("error", () => resolve(0));
	});
}

describe("foreign browser requests", () => {
	let fixture: Fixture;
	let port: number;
	let session: string;
	let device: string;
	let guest: string;

	before(async () => {
		fixture = await startFixture({ web: browserTests });
		port = fixture.server.port;
		const owner = fixture.browser();
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Mine" }, BACKGROUND_CONTEXT)
		).id;
		device = fixture.owner.cookie;
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		const link = (await until(sharing.links, (links) => Boolean(links?.length)))![0]!;
		const joined = await http(port, "/join", {
			method: "POST",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: JSON.stringify({ token: link.token, name: "Guest" }),
		});
		guest = cookieOf(joined.headers, `p2_guest_${port}`);
		assert.ok(guest, "a guest cookie");
	});
	after(() => fixture?.close());

	it("authenticates no credential of a foreign subresource, fetch or WebSocket", async () => {
		const check = (headers: Record<string, string>) => http(port, "/owner/check", { headers });
		for (const site of ["same-site", "cross-site"]) {
			const foreign = { ...NO_CORS, "Sec-Fetch-Site": site };
			assert.equal((await check({ ...foreign, Cookie: device })).status, 401, `${site}: the owner cookie`);
			assert.equal((await check(foreign)).status, 401, `${site}: no credential`);
			assert.equal(
				(await http(port, "/owner-token", { headers: { ...foreign, Cookie: device } })).status,
				403,
				`${site}: no invitation`,
			);
			// A guest cookie: not that guest (403 for a guest outside the web UI, 401 for nobody).
			assert.equal((await http(port, `/s/${session}`, { headers: { ...foreign, Cookie: guest } })).status, 401);
			const socket = { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "websocket", "Sec-Fetch-Dest": "websocket" };
			assert.equal(await upgrade(port, { ...socket, Cookie: device }), 403, `${site}: no owner WebSocket`);
			assert.equal(await upgrade(port, { ...socket, Cookie: guest }), 403, `${site}: no guest WebSocket`);
			// Framing the app is no navigation either.
			const framed = { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" };
			assert.equal((await http(port, "/", { headers: { ...framed, Cookie: device } })).status, 401);
		}
		// The page's own requests, and clients without Fetch Metadata (the TUI, scripts), are unaffected.
		assert.equal((await check({ "Sec-Fetch-Site": "same-origin", Cookie: device })).status, 200);
		assert.equal((await check({ Cookie: device })).status, 200);
		assert.equal(await upgrade(port, { Cookie: device }), 101);
		assert.equal(await upgrade(port, { Cookie: guest }), 101);
		// Loopback without a credential is nobody.
		assert.equal((await check({})).status, 401);
		assert.equal(await upgrade(port, {}), 403);
	});

	it("loads app pages on a foreign top-level navigation with the owner's cookie, else signs in", async () => {
		for (const site of ["same-site", "cross-site"]) {
			const navigate = { ...NAVIGATE, "Sec-Fetch-Site": site };
			const page = await http(port, "/", { headers: { ...navigate, Cookie: device } });
			assert.notEqual(page.status, 401, `${site} navigation with the cookie opens the app`);
			assert.ok(cookieOf(page.headers, `p2_owner_${port}`), "and renews the owner's local session");
			// A sidebar list's address is an app page too (`/list/<key>`).
			const list = await http(port, "/list/folder%3AW251bGwsIi93Il0", { headers: { ...navigate, Cookie: device } });
			assert.notEqual(list.status, 401, `${site} navigation to a list with the cookie opens the app`);
			const signIn = await http(port, `/s/${session}`, { headers: navigate });
			assert.equal(signIn.status, 401, `${site} navigation without a cookie signs in`);
			assert.match(signIn.body, /if\(!location\.hash\)location\.replace\(location\.href\);/, "after one reload");
			// Navigations elsewhere than app pages stay unauthenticated.
			assert.equal((await http(port, "/owner-token", { headers: { ...navigate, Cookie: device } })).status, 403);
			assert.equal((await http(port, "/owner/check", { headers: { ...navigate, Cookie: device } })).status, 401);
		}
	});

	it("loads the app when Chrome on Android launches the installed app (navigate, Dest empty, no cookie)", async () => {
		// As logged on the phone: a WebAPK launch of start_url `/` is cross-site, `navigate` with `Sec-Fetch-Dest: empty`.
		const launch = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "empty" };
		const page = await http(port, "/", { headers: { ...launch, Cookie: device } });
		assert.notEqual(page.status, 401, "the launch opens the app");
		// Without its cookie the launch gets the sign-in page, which loads itself once more from p2's own origin.
		const cookieless = await http(port, "/", { headers: launch });
		assert.equal(cookieless.status, 401);
		assert.match(cookieless.body, /location\.replace\(location\.href\)/);
		const again = await http(port, "/", { headers: { "Sec-Fetch-Site": "same-origin", ...NAVIGATE } });
		assert.equal(again.status, 401);
		assert.doesNotMatch(again.body, /location\.replace\(location\.href\)/, "the same-origin load does not loop");
		// Only a navigation: another site's fetch (Dest empty, mode cors or no-cors) still gets nobody.
		for (const mode of ["cors", "no-cors"]) {
			const fetched = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": mode, "Sec-Fetch-Dest": "empty" };
			assert.equal((await http(port, "/", { headers: { ...fetched, Cookie: device } })).status, 401, mode);
		}
	});

	it(
		"in Chromium, a page on another local port can neither read nor drive p2; its links open the app",
		{ skip: !browserTests, timeout: 120_000 },
		async () => {
			const p2 = `http://127.0.0.1:${port}`;
			const page = `<!doctype html><a id="open" href="${p2}/">Open p2</a><script>
				window.results = (async () => {
					const out = {};
					const settle = (name, promise) => promise.then(() => (out[name] = "read"), () => (out[name] = "blocked"));
					await settle("fetch", fetch(${JSON.stringify(`${p2}/owner/check`)}, { credentials: "include" }).then((r) => r.text()));
					await settle("module", import(${JSON.stringify(`${p2}/__p2_tui`)}));
					await settle("source", fetch(${JSON.stringify(`${p2}/__p2_tui`)}, { credentials: "include" }).then((r) => r.text()));
					await fetch(${JSON.stringify(`${p2}/owner/logout-all`)}, { method: "POST", credentials: "include", mode: "no-cors" }).catch(() => {});
					await fetch(${JSON.stringify(`${p2}/owner-token`)}, { credentials: "include", mode: "no-cors" }).catch(() => {});
					out.socket = await new Promise((resolve) => {
						const socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/chord`)});
						socket.onopen = () => resolve("open");
						socket.onerror = () => resolve("refused");
					});
					return out;
				})();
			</script>`;
			const foreign: Server = createServer((_request, response) => {
				response.writeHead(200, { "Content-Type": "text/html" });
				response.end(page);
			});
			foreign.listen(0, "127.0.0.1");
			await new Promise((resolve) => foreign.once("listening", resolve));
			const foreignOrigin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
			const owner = await Browser.start();
			await owner.signIn(fixture.owner);
			const fresh = await Browser.start();
			const ownerUi = `document.querySelector('.composer textarea') && !document.querySelector('nav[aria-label="Shared session"]') && !document.querySelector('.offline')`;
			try {
				// Every request the browser sends to p2: its URL, whether it carried the owner cookie, and p2's status.
				const seen = new Map<string, { url: string; cookie?: boolean; status?: number }>();
				owner.socket.on("message", (raw) => {
					const message = JSON.parse(raw.toString()) as {
						method?: string;
						params?: {
							requestId: string;
							request?: { url: string };
							headers?: Record<string, string>;
							statusCode?: number;
						};
					};
					const params = message.params;
					if (!params?.requestId) return;
					const entry = seen.get(params.requestId) ?? { url: "" };
					if (message.method === "Network.requestWillBeSent" && params.request) entry.url = params.request.url;
					if (message.method === "Network.requestWillBeSentExtraInfo")
						entry.cookie = Object.entries(params.headers ?? {}).some(
							([name, value]) => name.toLowerCase() === "cookie" && value.includes(`p2_owner_${port}=`),
						);
					if (message.method === "Network.responseReceivedExtraInfo") entry.status = params.statusCode;
					seen.set(params.requestId, entry);
				});
				await owner.call("Network.enable");
				await owner.open(`${p2}/`);
				await owner.wait(ownerUi);
				seen.clear();

				await owner.open(`${foreignOrigin}/`);
				const results = await owner.evaluate<Record<string, string>>("window.results");
				assert.deepEqual(results, {
					fetch: "blocked",
					module: "blocked",
					source: "blocked",
					socket: "refused",
				});
				// The page's requests to p2: each carried the owner's cookie (SameSite does not separate ports), and p2
				// authenticated none of them.
				const paths = ["/owner/check", "/__p2_tui", "/owner/logout-all", "/owner-token"];
				for (const path of paths) {
					const requests = [...seen.values()].filter((entry) => entry.url === `${p2}${path}`);
					// (A module import sends no cookie cross-origin; the credentialed fetch of the same URL does.)
					assert.ok(
						requests.some((entry) => entry.cookie),
						`${path} was requested with the owner cookie`,
					);
					for (const entry of requests)
						assert.ok(entry.status !== undefined && entry.status >= 400, `${path} answered ${entry.status}`);
				}

				// Its link opens the app for the owner; a browser without any p2 cookie gets the sign-in page.
				await owner.click("#open");
				await owner.wait(`location.origin === ${JSON.stringify(p2)}`);
				await owner.wait(ownerUi);
				await fresh.open(`${foreignOrigin}/`);
				await fresh.click("#open");
				// (The sign-in page reloads itself once from p2's origin: evaluating may hit the navigation.)
				const signInShown = `location.origin === ${JSON.stringify(p2)} && Boolean(document.querySelector("#sign-in"))`;
				await poll(() => fresh.evaluate<boolean>(signInShown).catch(() => false), 30_000, "the sign-in page");
			} finally {
				await owner.close();
				await fresh.close();
				foreign.close();
			}
		},
	);
});
