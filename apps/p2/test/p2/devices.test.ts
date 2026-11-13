import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { WebSocket } from "ws";
import { DeviceAccesses, Devices } from "../../plugins/devices/contract.ts";
import { OwnerAccess } from "../../plugins/devices/owner-access.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { Access } from "../../src/runtime/access.ts";
import {
	LOCAL_CHALLENGE_PATH,
	LOCAL_CLAIM_PATH,
	localOwnerProof,
	localOwnerSignIn,
} from "../../src/runtime/local-owner.ts";
import { clientHost, expectChord, holdIn, http, poll, startFixture, until, webAssets } from "./helpers.ts";

const TUNNEL = { Host: "owner.test", Origin: "https://owner.test" };
const requestWith = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
const signedIn = (access: OwnerAccess, cookie: string, port: number) =>
	access.session(requestWith(cookie), port) !== undefined;

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
	assert(signedIn(access, cookie, 8788));
	assert(!signedIn(access, cookie, 8789), "cookies are scoped to the server port");
	assert(!signedIn(access, `${cookie.slice(0, -1)}!`, 8788));
	assert(!signedIn(access, "p2_owner_8788=bad", 8788));
	const unfinished = access.issueToken();
	access.close();
	assert(!access.claim(unfinished));
	const reopened = await OwnerAccess.open(directory, () => now);
	assert(signedIn(reopened, cookie, 8788), "the installation key persists");
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
		assert.equal((await http(port, (await webAssets(port, headers)).script, { headers })).status, 200);
		assert.equal((await http(port, "/owner-token", { headers })).status, 403);
		const localOwner = { Cookie: fixture.owner.cookie };
		assert.equal((await http(port, "/owner-token")).status, 403, "loopback without a credential is nobody");
		for (const site of ["cross-site", "same-site", "none"])
			assert.equal(
				(await http(port, "/owner-token", { headers: { ...localOwner, "Sec-Fetch-Site": site } })).status,
				403,
				`/owner-token refuses Sec-Fetch-Site: ${site}`,
			);
		assert.equal(
			(await http(port, "/owner-token", { headers: { ...localOwner, "Sec-Fetch-Site": "same-origin" } })).status,
			200,
		);
		assert.equal((await http(port, "/owner-token", { headers: localOwner })).status, 200);
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
		assert.equal(internal.session(requestWith(cookie), port)?.kind, "device");
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
	assert(!signedIn(access, `p2_owner_8788=${legacy}`, 8788));
	const one = access.cookie(8788, true).split(";")[0]!;
	const two = access.cookie(8788, true).split(";")[0]!;
	const local = access.localCookie(8788).split(";")[0]!;
	assert(one !== two);
	assert(signedIn(access, one, 8788));
	const device = access.session(requestWith(one), 8788);
	assert(device);
	await access.logout(device);
	assert(!signedIn(access, one, 8788));
	assert(signedIn(access, two, 8788));
	assert.equal((await stat(join(directory, "owner-revoked.json"))).mode & 0o777, 0o600);
	await access.close();
	access = await OwnerAccess.open(directory, () => now);
	assert(!signedIn(access, one, 8788), "individual revocation survives restart");
	assert(signedIn(access, two, 8788));
	assert.equal(access.session(requestWith(local), 8788)?.kind, "local");
	await access.rotate();
	assert(!signedIn(access, two, 8788));
	assert(!signedIn(access, local, 8788), "rotation ends local sessions too");
	const fresh = access.cookie(8788, false);
	assert(fresh.includes("SameSite=Lax") && !fresh.includes("Secure"));
	const freshCookie = fresh.split(";")[0]!;
	assert(signedIn(access, freshCookie, 8788));
	now += 30 * 24 * 60 * 60_000;
	assert(!signedIn(access, freshCookie, 8788), "server-side cookie expiry is enforced");
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

test("the data directory is private: the server makes it 0700 and its owner key 0600", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "p2-private-data-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dataDir = join(root, "data");
	await mkdir(dataDir, { mode: 0o755 });
	await chmod(dataDir, 0o755);
	const server = await startServer({ dataDir, port: 0, fake: true, web: false });
	try {
		assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
		assert.equal((await stat(join(dataDir, "owner-key"))).mode & 0o777, 0o600);
	} finally {
		await server.close();
	}
});

test("loopback without a credential is nobody: pages ask to sign in, owner routes and WebSockets refuse", async (t) => {
	const fixture = await startFixture({ web: true });
	t.after(() => fixture.close());
	const port = fixture.server.port;
	const page = await http(port, "/");
	assert.equal(page.status, 401);
	assert(page.body.includes("Sign in to Pi"));
	assert.equal(page.headers["set-cookie"], undefined);
	assert.equal((await http(port, "/s/anything")).status, 401);
	assert.equal((await http(port, "/owner/check")).status, 401);
	assert.equal((await http(port, "/__p2_dev")).status, 403);
	assert.equal((await http(port, "/__p2_tui")).status, 401);
	assert.equal((await http(port, "/health")).status, 200, "readiness stays unauthenticated");
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`);
	const refused = await new Promise<number>((resolve) => {
		socket.on("error", () => {});
		socket.on("unexpected-response", (_request, response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		socket.on("open", () => resolve(101));
	});
	socket.terminate();
	assert.equal(refused, 403);
	assert.equal((await http(port, "/", { headers: { Cookie: fixture.owner.cookie } })).status, 200);
});

test("local sign-in: a one-time, port-bound challenge answered with the data directory's owner key", async (t) => {
	const fixture = await startFixture({ allowedHosts: ["owner.test"] });
	t.after(() => fixture.close());
	const port = fixture.server.port;
	const origin = `http://127.0.0.1:${port}`;
	const key = (await readFile(join(fixture.dataDir, "owner-key"), "utf8")).trim();
	const post = (path: string, body: unknown, headers: Record<string, string> = { Origin: origin }) =>
		http(port, path, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const challenge = async () => {
		const response = await post(LOCAL_CHALLENGE_PATH, {});
		assert.equal(response.status, 200);
		return (JSON.parse(response.body) as { challenge: string }).challenge;
	};
	// Not for another origin, a tunnel host or without the exact Origin.
	assert.equal((await post(LOCAL_CHALLENGE_PATH, {}, { Origin: "http://127.0.0.1:1" })).status, 403);
	assert.equal((await post(LOCAL_CHALLENGE_PATH, {}, {})).status, 403);
	assert.equal((await post(LOCAL_CHALLENGE_PATH, {}, TUNNEL)).status, 403);
	const first = await challenge();
	assert.equal(
		(await post(LOCAL_CLAIM_PATH, { challenge: first, proof: localOwnerProof("f".repeat(64), port, first) })).status,
		403,
		"another key's answer is refused",
	);
	assert.equal(
		(await post(LOCAL_CLAIM_PATH, { challenge: first, proof: localOwnerProof(key, port, first) })).status,
		403,
		"a challenge works once, even after a wrong answer",
	);
	const second = await challenge();
	assert.equal(
		(await post(LOCAL_CLAIM_PATH, { challenge: second, proof: localOwnerProof(key, port + 1, second) })).status,
		403,
		"an answer for another port is refused",
	);
	const third = await challenge();
	const tunnelClaim = await post(
		LOCAL_CLAIM_PATH,
		{ challenge: third, proof: localOwnerProof(key, port, third) },
		TUNNEL,
	);
	assert.equal(tunnelClaim.status, 403, "no local sign-in on a tunnel host");
	const fourth = await challenge();
	const claimed = await post(LOCAL_CLAIM_PATH, { challenge: fourth, proof: localOwnerProof(key, port, fourth) });
	assert.equal(claimed.status, 200);
	const setCookie = String(claimed.headers["set-cookie"]);
	assert.match(
		setCookie,
		/^p2_owner_\d+=local\.[a-f0-9]{32}\.\d+\.[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/,
	);
	assert(!setCookie.includes(key), "the cookie is a session, never the key");
	const cookie = setCookie.split(";")[0]!;
	const owner = clientHost({ port, cookie });
	t.after(() => owner.close(BACKGROUND_CONTEXT));
	const devices = owner.hold(Devices, {}, BACKGROUND_CONTEXT);
	assert.equal(await until(devices.canMint, (value) => value === true), true, "a local session has local powers");
	assert.equal(
		(await http(port, "/owner/check", { headers: { ...TUNNEL, Cookie: cookie } })).status,
		401,
		"a local session copied to a tunnel host is nobody",
	);
	// The client helper signs in the same way; another data directory gets a clear error, a missing key a reason.
	const other = await mkdtemp(join(tmpdir(), "p2-other-data-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	const missing = await localOwnerSignIn(new URL(origin), other);
	assert.equal(missing.kind, "unavailable");
	await writeFile(join(other, "owner-key"), "a".repeat(64));
	const mismatch = await localOwnerSignIn(new URL(origin), other);
	assert(mismatch.kind === "unavailable" && /does not use the data directory/.test(mismatch.message));
	assert.equal((await localOwnerSignIn(new URL(origin), fixture.dataDir)).kind, "signed-in");
});

test("an owner link redeemed on loopback is a local session, renewed on app loads and ended by sign-out of all devices", async (t) => {
	const fixture = await startFixture({ web: true });
	t.after(() => fixture.close());
	const port = fixture.server.port;
	const origin = `http://127.0.0.1:${port}`;
	const minted = await http(port, "/owner-token", { headers: { Cookie: fixture.owner.cookie } });
	const { token } = JSON.parse(minted.body) as { token: string };
	const claimed = await http(port, "/owner/claim", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	assert.equal(claimed.status, 200);
	const cookie = String(claimed.headers["set-cookie"]).split(";")[0]!;
	assert.match(cookie, /=local\./);
	assert(!String(claimed.headers["set-cookie"]).includes("Secure"));
	const browser = fixture.client({ Cookie: cookie });
	const devices = browser.host.hold(Devices, {}, BACKGROUND_CONTEXT);
	assert.equal(await until(devices.canMint, (value) => value === true), true);
	// Each app load renews the same session for another 30 days; other routes leave it alone.
	const id = (value: string) => /=local\.([a-f0-9]{32})\./.exec(value)?.[1];
	const loaded = await http(port, "/", { headers: { Cookie: cookie } });
	assert.equal(loaded.status, 200);
	const renewed = String(loaded.headers["set-cookie"]);
	assert.match(renewed, /SameSite=Lax; Path=\/; Max-Age=2592000$/);
	assert.equal(id(renewed), id(cookie));
	assert.equal((await http(port, "/owner/check", { headers: { Cookie: cookie } })).headers["set-cookie"], undefined);
	assert.equal((await http(port, "/", { headers: { Cookie: renewed.split(";")[0]! } })).status, 200);
	// Sign-out of this local browser ends its cookie only; sign-out of all devices ends every local session too.
	const tui = fixture.client({ Cookie: fixture.owner.cookie });
	await whenLive(tui.host.hold(Access, {}, BACKGROUND_CONTEXT));
	const logout = (path: string, value: string) =>
		http(port, path, { method: "POST", headers: { Origin: origin, Cookie: value } });
	assert.equal((await logout("/owner/logout", cookie)).status, 200);
	assert.equal((await http(port, "/owner/check", { headers: { Cookie: cookie } })).status, 401);
	assert.equal((await http(port, "/owner/check", { headers: { Cookie: fixture.owner.cookie } })).status, 200);
	assert.equal(tui.socket.readyState, 1, "other local sessions keep their links");
	assert.equal((await logout("/owner/logout-all", fixture.owner.cookie)).status, 200);
	await poll(() => tui.socket.readyState === 3);
	assert.equal((await http(port, "/owner/check", { headers: { Cookie: fixture.owner.cookie } })).status, 401);
	assert.equal((await localOwnerSignIn(new URL(origin), fixture.dataDir)).kind, "signed-in", "the new key signs in");
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
		env: {
			...process.env,
			PORT: String(fixture.server.port),
			P2_PUBLIC_URL: "https://owner.test",
			P2_DATA_DIR: fixture.dataDir,
		},
	});
	assert(
		overridden.stdout.split("\n").some((line) => line.startsWith(`http://127.0.0.1:${fixture.server.port}/owner#`)),
	);
	// Another user (no readable key) or another data directory gets a clear error, never a link.
	const other = await mkdtemp(join(tmpdir(), "p2-other-data-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	const elsewhere = (dataDir: string) =>
		run("npm", ["run", "owner-link"], {
			cwd,
			env: { ...process.env, PORT: String(fixture.server.port), P2_DATA_DIR: dataDir },
		}).then(
			() => assert.fail("owner-link must fail"),
			(error: { stderr: string }) => error.stderr,
		);
	assert.match(await elsewhere(other), /Cannot read .*owner-key: local sign-in needs the user running the p2 server/);
	await writeFile(join(other, "owner-key"), "a".repeat(64));
	assert.match(await elsewhere(other), /does not use the data directory/);
});
