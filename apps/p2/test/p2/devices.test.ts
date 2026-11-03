import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { DeviceAccesses, Devices } from "../../plugins/devices/contract.ts";
import { OwnerAccess } from "../../plugins/devices/owner-access.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { Access } from "../../src/runtime/access.ts";
import { expectChord, holdIn, http, poll, startFixture, until, webBundle } from "./helpers.ts";

const TUNNEL = { Host: "owner.test", Origin: "https://owner.test" };
const requestWith = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;

test("owner invitations are private, one use, bounded and expire after ten minutes; cookies survive restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-owner-access-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let now = 10_000;
	const access = await OwnerAccess.open(directory, () => now);
	const startup = (await readFile(join(directory, "owner-token.txt"), "utf8")).trim();
	assert.equal((await stat(join(directory, "owner-key"))).mode & 0o777, 0o600);
	assert.equal((await stat(join(directory, "owner-token.txt"))).mode & 0o777, 0o600);
	assert(access.claim(startup));
	assert(!access.claim(startup));
	const invitation = access.issueToken();
	assert(!access.claim("wrong"));
	assert(access.claim(` ${invitation}\n`));
	assert(!access.claim(invitation));
	const expired = access.issueToken();
	now += 600_000;
	assert(!access.claim(expired), "the ten-minute boundary is expired");
	const evicted = access.issueToken();
	for (let count = 0; count < 32; count++) access.issueToken();
	assert(!access.claim(evicted), "outstanding invitations are bounded");
	const cookie = access.cookie(8788, true).split(";")[0]!;
	assert(access.authorized(requestWith(cookie), 8788));
	assert(!access.authorized(requestWith(cookie), 8789), "cookies are scoped to the server port");
	assert(!access.authorized(requestWith(`${cookie.slice(0, -1)}!`), 8788));
	assert(!access.authorized(requestWith("p2_owner_8788=bad"), 8788));
	const unfinished = access.issueToken();
	access.close();
	assert(!access.claim(unfinished));
	const reopened = await OwnerAccess.open(directory, () => now);
	assert(reopened.authorized(requestWith(cookie), 8788), "the installation key persists");
	const nextStartup = (await readFile(join(directory, "owner-token.txt"), "utf8")).trim();
	assert.notEqual(nextStartup, startup);
	assert(!reopened.claim(unfinished), "in-memory invitations do not survive a restart");
	assert(reopened.claim(nextStartup));
	reopened.close();
	await writeFile(join(directory, "owner-key"), "invalid-private-key");
	await assert.rejects(OwnerAccess.open(directory), /Invalid owner key/);
});

test("Devices plugin signs in a remote owner over HTTP/WS, never grants remote or guest token minting", async () => {
	const fixture = await startFixture({
		allowedHosts: ["owner.test"],
		web: true,
	});
	let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
	try {
		const port = fixture.server.port;
		const local = fixture.browser();
		const devices = local.hold(Devices, {}, BACKGROUND_CONTEXT);
		assert.equal(await until(devices.canMint, (value) => value === true), true);
		const relayDevices = fixture.as({ kind: "owner", access: "relay" }).hold(Devices, {}, BACKGROUND_CONTEXT);
		await expectChord(relayDevices.token(BACKGROUND_CONTEXT), "forbidden");
		relayDevices.release();
		const workerDevices = fixture
			.as({ kind: "worker", session: "s", generation: 1 })
			.hold(Devices, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(workerDevices), "forbidden");
		workerDevices.release();
		const token = (await devices.token(BACKGROUND_CONTEXT)).token;
		const landing = await http(port, "/owner", { headers: TUNNEL });
		assert.equal(landing.status, 200);
		assert(landing.body.includes("One-time token") && landing.body.includes("Devices"));
		assert(landing.body.includes('fetch("/owner/claim"'));
		assert(landing.body.includes('type="password"'));
		assert(!landing.body.includes(token));
		assert.match(String(landing.headers["content-security-policy"]), /script-src 'nonce-/);
		assert.equal((await http(port, "/owner", { headers: TUNNEL, method: "HEAD" })).body, "");
		assert.equal(landing.headers["set-cookie"], undefined);
		const claim = (body: string, headers = TUNNEL) =>
			http(port, "/owner/claim", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body,
			});
		assert.equal((await claim(JSON.stringify({ token }), { ...TUNNEL, Origin: "https://foreign.test" })).status, 403);
		assert.equal(
			(
				await http(port, "/owner/claim", {
					method: "POST",
					headers: { Host: TUNNEL.Host },
					body: JSON.stringify({ token }),
				})
			).status,
			403,
		);
		assert.equal((await claim("{")).status, 400);
		assert.equal((await claim("x".repeat(1025))).status, 413);
		assert.equal((await claim(JSON.stringify({ token: "wrong" }))).status, 403);
		const accepted = await claim(JSON.stringify({ token }));
		assert.equal(accepted.status, 200);
		assert.equal((await claim(JSON.stringify({ token }))).status, 403, "a token works once");
		const setCookie = String(accepted.headers["set-cookie"]);
		assert.match(setCookie, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure/);
		const cookie = setCookie.split(";")[0]!;
		const headers = { ...TUNNEL, Cookie: cookie };
		assert.equal((await http(port, "/", { headers })).status, 200);
		assert.equal((await http(port, (await webBundle(port, headers)).script, { headers })).status, 200);
		assert.equal((await http(port, "/owner-token", { headers })).status, 403);
		assert.equal((await http(port, "/owner-token", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
		assert.equal((await http(port, "/owner-token")).status, 200);
		assert.equal((await http(port, "/", { headers: { ...headers, Cookie: "wrong" } })).status, 401);
		assert.equal((await http(port, "/", { headers: { ...headers, Host: "wrong.test" } })).status, 403);
		assert.equal((await http(port, "/", { headers: { "X-Forwarded-For": "203.0.113.7" } })).status, 403);
		assert.equal((await http(port, "/owner-key", { headers })).status, 404);
		assert.notEqual((await http(port, `/@fs${join(fixture.dataDir, "owner-token.txt")}`, { headers })).status, 200);
		const remote = fixture.client(headers).host;
		await holdIn(remote, Access, {}, "owner");
		const remoteDevices = remote.hold(Devices, {}, BACKGROUND_CONTEXT);
		assert.equal(await until(remoteDevices.canMint, (value) => value === false), false);
		await expectChord(remoteDevices.token(BACKGROUND_CONTEXT), "forbidden");
		const login = remote.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		await whenLive(login);
		assert.equal(login.variant, "owner", "associated devices retain remote owner provider access");
		const internal = (await fixture.server.host.registry(DeviceAccesses, BACKGROUND_CONTEXT)).value!.access;
		assert(internal.authorized(requestWith(cookie), port));
		const outstanding = (await devices.token(BACKGROUND_CONTEXT)).token;
		await fixture.server.reload(["devices"]);
		const afterReload = await claim(JSON.stringify({ token: outstanding }));
		assert.equal(afterReload.status, 200, "compatible reloads retain invitations and the owner key");
		const session = await (await holdIn(local, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const sharing = local.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const joined = await http(port, "/join", {
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			method: "POST",
			body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
		});
		assert.equal(joined.status, 200);
		const guestCookie = String(joined.headers["set-cookie"]).split(";")[0]!;
		const guest = fixture.client({ ...TUNNEL, Cookie: guestCookie }).host;
		await expectChord(whenLive(guest.hold(Devices, {}, BACKGROUND_CONTEXT)), "forbidden");
		assert.equal((await http(port, "/owner-token", { headers: { ...TUNNEL, Cookie: guestCookie } })).status, 403);
		const both = fixture.client({ ...TUNNEL, Cookie: `${guestCookie}; ${cookie}` }).host;
		const ownerAgain = await holdIn(both, Access, {}, "owner");
		assert.equal(ownerAgain.variant, "owner", "an owner cookie is not downgraded by an existing guest cookie");
		const startup = (await readFile(join(fixture.dataDir, "owner-token.txt"), "utf8")).trim();
		assert.equal((await claim(JSON.stringify({ token: startup }))).status, 200, "headless startup token signs in");
		await fixture.server.close();
		restarted = await startServer({
			dataDir: fixture.dataDir,
			port,
			fake: true,
			web: false,
			allowedHosts: ["owner.test"],
		});
		assert.equal(
			(await http(port, "/owner-token", { headers })).status,
			403,
			"the old cookie remains a remote owner after restart",
		);
		assert.equal((await http(port, "/", { headers })).status, 404, "authorized owner reaches the UI-less server");
		const fresh = (await readFile(join(fixture.dataDir, "owner-token.txt"), "utf8")).trim();
		assert.notEqual(fresh, startup);
		assert.equal((await claim(JSON.stringify({ token: startup }))).status, 403);
		assert.equal((await claim(JSON.stringify({ token: fresh }))).status, 200);
	} finally {
		await restarted?.close();
		await fixture.close();
	}
});

test("signed cookies expire, logout persists, all-device rotation invalidates cookies and legacy key cookies cannot forge", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-owner-revoke-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const legacy = "e".repeat(64);
	await writeFile(join(directory, "owner-key"), legacy, { mode: 0o600 });
	let now = 1000;
	let access = await OwnerAccess.open(directory, () => now);
	assert(
		(await readFile(join(directory, "owner-key"), "utf8")).trim() !== legacy,
		"the old bearer key must not become a signing key",
	);
	assert(!access.authorized(requestWith(`p2_owner_8788=${legacy}`), 8788));
	const one = access.cookie(8788, true).split(";")[0]!;
	const two = access.cookie(8788, true).split(";")[0]!;
	assert(one !== two);
	assert(access.authorized(requestWith(one), 8788));
	const device = access.device(requestWith(one), 8788);
	assert(device);
	await access.logout(device);
	assert(!access.authorized(requestWith(one), 8788));
	assert(access.authorized(requestWith(two), 8788));
	assert.equal((await stat(join(directory, "owner-revoked.json"))).mode & 0o777, 0o600);
	await access.close();
	access = await OwnerAccess.open(directory, () => now);
	assert(!access.authorized(requestWith(one), 8788), "individual revocation survives restart");
	assert(access.authorized(requestWith(two), 8788));
	await access.rotate();
	assert(!access.authorized(requestWith(two), 8788));
	const fresh = access.cookie(8788, false);
	assert(fresh.includes("SameSite=Lax") && !fresh.includes("Secure"));
	const freshCookie = fresh.split(";")[0]!;
	assert(access.authorized(requestWith(freshCookie), 8788));
	now += 30 * 24 * 60 * 60_000;
	assert(!access.authorized(requestWith(freshCookie), 8788), "server-side cookie expiry is enforced");
	await access.close();
});

test("sign out this device and all devices revoke live sockets as well as cookies", async (t) => {
	const fixture = await startFixture({ allowedHosts: ["owner.test"] });
	t.after(() => fixture.close());
	const local = fixture.browser().hold(Devices, {}, BACKGROUND_CONTEXT);
	const claim = async () => {
		const { token } = await local.token(BACKGROUND_CONTEXT);
		const response = await http(fixture.server.port, "/owner/claim", {
			method: "POST",
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		assert.equal(response.status, 200);
		return String(response.headers["set-cookie"]).split(";")[0]!;
	};
	const one = await claim(),
		two = await claim();
	const first = fixture.client({ ...TUNNEL, Cookie: one });
	const second = fixture.client({ ...TUNNEL, Cookie: two });
	await whenLive(first.host.hold(Access, {}, BACKGROUND_CONTEXT));
	await whenLive(second.host.hold(Access, {}, BACKGROUND_CONTEXT));
	const logout = (cookie: string, all: boolean, origin = TUNNEL.Origin) =>
		http(fixture.server.port, all ? "/owner/logout-all" : "/owner/logout", {
			method: "POST",
			headers: { ...TUNNEL, Origin: origin, Cookie: cookie },
		});
	assert.equal((await logout(one, true, "https://foreign.test")).status, 403);
	const result = await logout(one, false);
	assert.equal(result.status, 200);
	assert(String(result.headers["set-cookie"]).includes("Max-Age=0"));
	await poll(() => first.socket.readyState === 3);
	assert.equal((await http(fixture.server.port, "/owner/check", { headers: { ...TUNNEL, Cookie: one } })).status, 401);
	assert.equal((await http(fixture.server.port, "/owner/check", { headers: { ...TUNNEL, Cookie: two } })).status, 200);
	assert.equal((await logout("wrong", true)).status, 403);
	assert.equal((await logout(two, true)).status, 200);
	await poll(() => second.socket.readyState === 3);
	assert.equal((await http(fixture.server.port, "/owner/check", { headers: { ...TUNNEL, Cookie: two } })).status, 401);
});

test("npm run owner-link mints a private fragment link from the running device path without a browser", async (t) => {
	const fixture = await startFixture({ allowedHosts: ["owner.test"] });
	t.after(() => fixture.close());
	const run = promisify(execFile);
	const cwd = new URL("../../", import.meta.url).pathname;
	const { stdout } = await run("npm", ["run", "owner-link"], {
		cwd,
		env: {
			...process.env,
			PORT: String(fixture.server.port),
			P2_PUBLIC_URL: "https://owner.test",
			P2_DATA_DIR: fixture.dataDir,
		},
	});
	const link = stdout.split("\n").find((line) => line.startsWith("https://owner.test/owner#"));
	assert(link, "the CLI emits the invitation link");
	const url = new URL(link);
	assert(/^#[a-f0-9]{64}$/.test(url.hash));
	assert.equal(url.search, "");
	const body = JSON.stringify({ token: url.hash.slice(1) });
	const claim = () =>
		http(fixture.server.port, "/owner/claim", {
			method: "POST",
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			body,
		});
	assert.equal((await claim()).status, 200);
	assert.equal((await claim()).status, 403);
	const overridden = await run("npm", ["run", "owner-link", "--", `http://127.0.0.1:${fixture.server.port}`], {
		cwd,
		env: { ...process.env, PORT: String(fixture.server.port), P2_PUBLIC_URL: "https://owner.test" },
	});
	assert(
		overridden.stdout.split("\n").some((line) => line.startsWith(`http://127.0.0.1:${fixture.server.port}/owner#`)),
	);
});
