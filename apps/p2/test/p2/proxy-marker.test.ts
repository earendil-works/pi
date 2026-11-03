import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Devices } from "../../plugins/devices/contract.ts";
import { DownloadStore } from "../../plugins/files/contract.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import { PROXY_MARKER_HEADER } from "../../plugins/proxy-marker/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { type Fixture, holdIn, http, startFixture, until } from "./helpers.ts";

const PROXIED = { Host: "p2.proxy.test", Origin: "https://p2.proxy.test", [PROXY_MARKER_HEADER]: "1" };
async function refused(port: number, path: string, headers: Record<string, string>): Promise<void> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
	await new Promise<void>((resolve, reject) => {
		socket.on("error", () => {});
		socket.once("unexpected-response", (_request, response) => {
			response.resume();
			socket.terminate();
			assert.equal(response.statusCode, 403);
			resolve();
		});
		socket.once("open", () => {
			socket.terminate();
			reject(new Error("Stranger admitted to a WebSocket"));
		});
	});
}

describe("proxy marking is never authentication (including the loopback Unix-socket bridge)", () => {
	let fixture: Fixture;
	let cookie: string;
	let session: string;
	let file: string;
	let socketPath: string;
	let bridge: ReturnType<typeof createServer>;
	const viaBridge = (path: string): Promise<{ status: number; body: string }> =>
		new Promise((resolve, reject) => {
			const req = request({ socketPath, path, headers: PROXIED, agent: false }, (response) => {
				let body = "";
				response.on("data", (chunk) => {
					body += String(chunk);
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			});
			req.on("error", reject);
			req.end();
		});
	before(async () => {
		fixture = await startFixture({ allowedHosts: ["p2.proxy.test"], web: true });
		const owner = fixture.browser();
		const created = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "PRIVATE catalogue sentinel",
			},
			BACKGROUND_CONTEXT,
		);
		session = created.id;
		const source = join(fixture.workspace, "private.txt");
		await writeFile(source, "PRIVATE download payload");
		file = (
			await fixture.server.host.root(
				async (ctx) => (await ctx.get(DownloadStore, {})).save({ session, path: source }, ctx),
				BACKGROUND_CONTEXT,
			)
		).id;
		const token = (await owner.hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
		const signed = await http(fixture.server.port, "/owner/claim", {
			headers: { ...PROXIED, "Content-Type": "application/json" },
			method: "POST",
			body: JSON.stringify({ token }),
		});
		assert.equal(signed.status, 200);
		cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
		socketPath = join(fixture.dataDir, "proxy.sock");
		bridge = createServer((client) => {
			const upstream = connect(fixture.server.port, "127.0.0.1");
			client.pipe(upstream).pipe(client);
			const close = () => {
				client.destroy();
				upstream.destroy();
			};
			client.on("error", close);
			upstream.on("error", close);
		});
		await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
	});
	after(async () => {
		await new Promise<void>((resolve) => bridge.close(() => resolve()));
		await fixture.close();
	});

	it("a bridge request without a cookie is a stranger, not the machine owner", async () => {
		const response = await viaBridge("/");
		assert.equal(response.status, 401);
		assert(response.body.includes("Sign in to Pi"));
		assert(!response.body.includes("PRIVATE") && !response.body.includes("/__p2_web/"));
		assert.equal((await viaBridge("/owner-token")).status, 403);
	});
	it("a forged marker can only remove localhost/device trust", async () => {
		for (const marker of ["1", "forged", ""]) {
			assert.equal(
				(await http(fixture.server.port, "/owner-token", { headers: { [PROXY_MARKER_HEADER]: marker } })).status,
				403,
			);
			assert.equal(
				(await http(fixture.server.port, "/", { headers: { ...PROXIED, [PROXY_MARKER_HEADER]: marker } })).status,
				401,
			);
		}
		for (const path of ["/chord", "/terminal"]) await refused(fixture.server.port, path, PROXIED);
	});
	it("strangers cannot obtain application modules, sessions, files or upload anything", async () => {
		for (const path of [
			"/",
			`/s/${session}`,
			"/__p2_web",
			"/__p2_web/app-ANY.js",
			`/download?session=${session}&id=${file}`,
			`/workspace-file?session=${session}&path=private.txt`,
			`/artifact?session=${session}&name=private&version=1`,
		]) {
			const response = await http(fixture.server.port, path, { headers: PROXIED });
			assert([401, 403].includes(response.status));
			assert(!response.body.includes("PRIVATE") && !response.body.includes(session));
		}
		for (const path of [
			`/upload?session=${session}&name=intrude.txt`,
			`/workspace-upload?session=${session}&name=intrude.txt`,
		]) {
			const response = await http(fixture.server.port, path, {
				method: "POST",
				headers: PROXIED,
				body: "intrusion",
			});
			assert.equal(response.status, 403);
			assert(!response.body.includes("PRIVATE"));
		}
	});
	it("only a cookie grants proxied owner access, including provider controls", async () => {
		const { host } = fixture.client({ ...PROXIED, Cookie: cookie });
		const sessions = await holdIn(host, Sessions, {}, "owner");
		assert((await until(sessions.sessions, (value) => Boolean(value?.length)))?.some((item) => item.id === session));
		const login = host.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		await whenLive(login);
		assert.equal(login.variant, "owner");
		assert.equal(
			(await http(fixture.server.port, "/owner-token", { headers: { ...PROXIED, Cookie: cookie } })).status,
			403,
		);
	});
	it("guests still enter only through a share link, independently of the marker", async () => {
		const sharing = fixture.browser().hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { ...PROXIED, "Content-Type": "application/json" },
			body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
		});
		assert.equal(joined.status, 200);
		const guestCookie = String(joined.headers["set-cookie"]).split(";")[0]!;
		assert.equal(
			(
				await http(fixture.server.port, `/download?session=${session}&id=${file}`, {
					headers: { ...PROXIED, Cookie: guestCookie },
				})
			).status,
			200,
		);
		assert.equal(
			(await http(fixture.server.port, "/owner-token", { headers: { ...PROXIED, Cookie: guestCookie } })).status,
			403,
		);
	});
});
