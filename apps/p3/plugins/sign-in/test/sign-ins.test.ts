// The sign-ins (`sign-ins.ts`): tokens random, kept as SHA-256 hashes, matched in constant time; sign-ins issued,
// verified, listed and revoked through `SignIns`, only hashes kept; the authenticator taking a bearer token, else the
// signed cookie named after the Pi; a sign-in ending unused after 400 days; a sign-in's open links closed when it ends,
// only its own; and every link of a `SignIns` object closed when the object ends (a reload of the plugin); the
// sign-ins and the cookie's key kept across a restart. The plugin tier first (its facet alone, requests made by the
// test), then the real server (`testServer`) for what needs HTTP and `/chord` links; the probe's route
// (`GET /_probe/principal`) says what a request authenticated as.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	isChordError,
	type P3Principal,
	THIS_DEVICE,
	until,
	webSocketLink,
} from "@earendil-works/p3/v1";
import {
	Authenticators,
	type HttpRequest,
	hashToken,
	LinkOpened,
	matchesHash,
	newToken,
	PeopleStore,
} from "@earendil-works/p3/v1/server";
import { type TestedPlugin, type TestServer, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { collected, eventually, within } from "../../../test/until.ts";
import { Sessions } from "../../sessions/contract.ts";
import { SignIns } from "../contract.ts";

const DAY = 24 * 60 * 60_000;
/** A person whose sign-ins the identity tests issue (who they are does not matter to a sign-in). */
const OWNER: P3Principal = { kind: "person", id: "owner", name: "Owner" };

/** The owner's person of the server `host` (made at its first start): who the owner's objects admit. */
async function ownerOf(host: TestServer["host"]): Promise<P3Principal> {
	const [found] = (
		await host.root(async (ctx) => (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx), context)
	).items;
	return { kind: "person", id: found!.id, name: found!.name };
}
const MAX: P3Principal = { kind: "person", id: "max", name: "Max" };

/** A new coding session titled `title`, as the owner makes it. */
function coding(title: string) {
	return { app: "coding", title, location: { environment: THIS_DEVICE, folder: tmpdir() } };
}

/** The sign-in plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

/** The tests' probe plugin, whose route says what a request signed in as. */
const PROBE = fileURLToPath(new URL("../../../test/plugins/probe/", import.meta.url));

afterEach(() => mock.timers.reset());

/** A sign-in as `issue` answers it. */
type Issued = { readonly id: string; readonly token: string; readonly cookie: string };

describe("tokens", () => {
	it("are random base64url of their bytes, kept as their SHA-256 hash, and matched only by themselves", () => {
		const [one, other] = [newToken(), newToken()];
		assert.match(one, /^[A-Za-z0-9_-]{43}$/);
		assert.match(newToken(12), /^[A-Za-z0-9_-]{16}$/);
		assert.notEqual(one, other);
		assert.match(hashToken(one), /^[0-9a-f]{64}$/);
		assert.notEqual(hashToken(one), one);
		assert.deepEqual(
			[matchesHash(one, hashToken(one)), matchesHash(other, hashToken(one)), matchesHash(one, "")],
			[true, false, false],
		);
		// A stored hash that is no hex of the right length never matches.
		assert.equal(matchesHash(one, hashToken(one).slice(2)), false);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// The plugin tier: the server facet on a host of its own, beside the base's facet (a server that does not listen).

/** The plugin's server facet alone. */
function signInPlugin(): Promise<TestedPlugin<P3Principal>> {
	return testPlugin(PLUGIN, { kind: "server" }, context);
}

/** A sign-in of `principal` on `t`. */
function issue(
	t: TestedPlugin<P3Principal>,
	principal: P3Principal,
	kind: "browser" | "device",
	label = "test",
): Promise<Issued> {
	return t.root(async (ctx) => (await ctx.get(SignIns, {})).issue({ principal, label, kind }, ctx), context);
}

/** What `token` verifies as on `t`. */
function verify(t: TestedPlugin<P3Principal>, token: string): Promise<P3Principal | null> {
	return t.root(async (ctx) => (await ctx.get(SignIns, {})).verify(token, ctx), context);
}

/** Revokes sign-in `id` on `t`. */
function revoke(t: TestedPlugin<P3Principal>, id: string): Promise<null> {
	return t.root(async (ctx) => (await ctx.get(SignIns, {})).revoke(id, ctx), context);
}

/** The sign-ins `t` lists. */
function listed(t: TestedPlugin<P3Principal>) {
	return t.root(async (ctx) => (await ctx.get(SignIns, {})).list.value, context);
}

/** A request from this machine with `headers`, as the HTTP component admits one. */
function request(headers: Readonly<Record<string, string>>): HttpRequest {
	return {
		method: "GET",
		path: "/",
		params: {},
		query: new URLSearchParams(),
		headers: new Headers(headers),
		origin: "http://127.0.0.1",
		provenance: { kind: "local" },
		nonce: "nonce",
		remoteAddress: undefined,
		json: async () => null,
		body: async function* () {},
	};
}

/** The principal the plugin's authenticator gives `req` (none other is contributed). */
async function authenticate(t: TestedPlugin<P3Principal>, req: HttpRequest): Promise<P3Principal | undefined> {
	const [entry] = t.contributions(Authenticators);
	return (await entry!.value(req, context)) as P3Principal | undefined;
}

/** The `LinkOpened` hook (the base's, composed) on a link of `req`: whether it closed the link, and what it returns. */
async function open(t: TestedPlugin<P3Principal>, req: HttpRequest) {
	const hook = (await t.host.registry(LinkOpened, context)).value;
	const link = { closed: 0 };
	const end = hook(req, () => void link.closed++);
	return { link, end };
}

/** The headers carrying `issued`: its bearer token, or its cookie as a browser sends it. */
function carrying(issued: Issued, carry: "bearer" | "cookie"): Record<string, string> {
	return carry === "bearer" ? { authorization: `Bearer ${issued.token}` } : { cookie: issued.cookie.split(";")[0]! };
}

describe("the plugin's SignIns", () => {
	let t: TestedPlugin<P3Principal>;
	// What the load reported: the registries of Chord's HTTP component, which nobody serves here (the helper collects
	// them).
	let loaded: number;
	beforeEach(async () => {
		t = await signInPlugin();
		loaded = t.errors.length;
	});
	afterEach(() => t.close(context));

	it("issues a sign-in that verifies and authenticates by bearer and cookie, lists it without its hash, revokes it", async () => {
		const issued = await issue(t, MAX, "device", "Max's laptop");
		assert.match(issued.token, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		assert.equal(issued.token.split(".")[0], issued.id);
		assert.match(issued.cookie, /^p3-[A-Za-z0-9_-]{11}=[^;]+; HttpOnly; Path=\/; SameSite=Strict; Max-Age=34560000$/);
		assert.deepEqual(await verify(t, issued.token), MAX);
		assert.deepEqual(await authenticate(t, request(carrying(issued, "bearer"))), MAX);
		assert.deepEqual(await authenticate(t, request(carrying(issued, "cookie"))), MAX);
		const shown = (await listed(t)).find(({ id }) => id === issued.id)!;
		assert.deepEqual(Object.keys(shown).sort(), ["created", "id", "kind", "label", "lastUsed", "principal"]);
		assert.deepEqual([shown.label, shown.kind, shown.principal], ["Max's laptop", "device", MAX]);
		await revoke(t, issued.id);
		assert.equal(await verify(t, issued.token), null);
		assert.equal(await authenticate(t, request(carrying(issued, "cookie"))), undefined);
		assert.equal(
			(await listed(t)).some(({ id }) => id === issued.id),
			false,
		);
		assert.deepEqual(t.unserved(), []);
	});

	it("gives a secure browser's cookie `Secure`", async () => {
		const issued = await t.root(
			async (ctx) =>
				(await ctx.get(SignIns, {})).issue({ principal: OWNER, label: "b", kind: "browser", secure: true }, ctx),
			context,
		);
		assert.match(issued.cookie, /; Secure; Max-Age=34560000$/);
	});

	it("issues a sign-in only for one of p3's principals", async () => {
		// A value from outside the types, as a caller without type checks passes it.
		const admin = { kind: "admin" } as unknown as P3Principal;
		await assert.rejects(issue(t, admin, "device"), (error) => isChordError(error, "invalid"));
	});

	it("refuses a wrong secret, another sign-in's secret, an unknown id, a malformed token and a prototype key", async () => {
		const issued = await issue(t, OWNER, "device");
		const other = await issue(t, MAX, "device");
		const [id, secret] = issued.token.split(".");
		const refused = [
			`${id}.wrong`,
			`${id}.${other.token.split(".")[1]}`,
			`${id}.${secret}x`,
			`${id}.`,
			id!,
			`nope.${secret}`,
			"garbage",
			".x",
			"",
			"a.b.c",
			...["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].map((key) => `${key}.x`),
		];
		for (const token of refused) {
			assert.equal(await verify(t, token), null, token);
			assert.equal(await authenticate(t, request({ authorization: `Bearer ${token}` })), undefined, token);
		}
		assert.deepEqual(t.errors.slice(loaded), []);
	});

	it("takes the bearer token before the cookie, and a cookie only signed with this Pi's key", async () => {
		const device = await issue(t, MAX, "device");
		const browser = await issue(t, OWNER, "browser");
		const both = { ...carrying(device, "bearer"), ...carrying(browser, "cookie") };
		assert.deepEqual(await authenticate(t, request(both)), MAX);
		// Not a bearer token: the cookie.
		const basic = { authorization: `Basic ${device.token}`, ...carrying(browser, "cookie") };
		assert.deepEqual(await authenticate(t, request(basic)), OWNER);
		const inside = { authorization: `Basic Bearer ${device.token}`, ...carrying(browser, "cookie") };
		assert.deepEqual(await authenticate(t, request(inside)), OWNER);
		const [name, signed] = browser.cookie.split(";")[0]!.split("=") as [string, string];
		const forged = [
			`${name}=${browser.token}`,
			`${name}=${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`,
			`${name}=${encodeURIComponent(device.token)}${signed.slice(signed.indexOf(".", browser.id.length + 1))}`,
			`p3-other=${signed}`,
			`${name}=__proto__.x`,
		];
		for (const cookie of forged) assert.equal(await authenticate(t, request({ cookie })), undefined, cookie);
		assert.deepEqual(t.errors.slice(loaded), []);
	});

	it("keeps a sign-in used within 400 days, touching it at most once a minute", async () => {
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start });
		const issued = await issue(t, OWNER, "device", "d");
		const lastUsed = async () => (await listed(t)).find(({ id }) => id === issued.id)!.lastUsed;
		mock.timers.setTime(start + 30_000);
		assert.deepEqual(await verify(t, issued.token), OWNER);
		assert.equal(await lastUsed(), start);
		mock.timers.setTime(start + 61_000);
		assert.deepEqual(await verify(t, issued.token), OWNER);
		await t.root(
			async (ctx) =>
				until(
					(await ctx.get(SignIns, {})).list,
					(rows) => rows.some((row) => row.id === issued.id && row.lastUsed === start + 61_000),
					within("the touch", context),
				),
			context,
		);
		// The touch counts: 400 days and a moment after the issue it still signs in.
		mock.timers.setTime(start + 400 * DAY + 1);
		assert.deepEqual(await verify(t, issued.token), OWNER);
	});

	it("ends a sign-in unused for 400 days at its next use", async () => {
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start });
		const issued = await issue(t, OWNER, "device", "d");
		mock.timers.setTime(start + 400 * DAY);
		assert.deepEqual(await verify(t, issued.token), OWNER, "the 400th day still counts");
		// That use touched it: 400 days later again.
		mock.timers.setTime(start + 800 * DAY + 1);
		assert.equal(await verify(t, issued.token), null);
		await t.root(
			async (ctx) =>
				until(
					(await ctx.get(SignIns, {})).list,
					(rows) => !rows.some((row) => row.id === issued.id),
					within("the ended sign-in gone", context),
				),
			context,
		);
		assert.deepEqual(t.errors.slice(loaded), []);
	});
});

describe("the plugin's links of a sign-in", () => {
	let t: TestedPlugin<P3Principal>;
	beforeEach(async () => {
		t = await signInPlugin();
	});
	afterEach(() => t.close(context));

	/** A request carrying `issued`, authenticated, and its link opened. */
	async function linked(issued: Issued, carry: "bearer" | "cookie") {
		const req = request(carrying(issued, carry));
		assert.notEqual(await authenticate(t, req), undefined);
		return open(t, req);
	}

	it("revoking a sign-in closes its open links at once, and only its", async () => {
		const laptop = await issue(t, OWNER, "device");
		const phone = await issue(t, OWNER, "browser");
		const first = await linked(laptop, "bearer");
		const second = await linked(laptop, "cookie");
		const third = await linked(laptop, "bearer");
		const kept = await linked(phone, "cookie");
		// A link that closed on its own is no longer the sign-in's.
		third.end!();
		await revoke(t, laptop.id);
		assert.deepEqual([first.link.closed, second.link.closed, third.link.closed, kept.link.closed], [1, 1, 0, 0]);
	});

	it("an expired sign-in's links close at its next use", async () => {
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start });
		const laptop = await issue(t, OWNER, "device");
		const { link } = await linked(laptop, "bearer");
		mock.timers.setTime(start + 401 * DAY);
		assert.equal(await verify(t, laptop.token), null);
		// The end is not awaited by the use; `eventually` would wait on the mocked clock.
		for (let turn = 0; turn < 100 && link.closed === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(link.closed, 1);
	});

	it("a link of a sign-in that ended after its request authenticated is closed at once", async () => {
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start });
		for (const [carry, race] of [
			["bearer", "revoke"],
			["bearer", "expire"],
			["cookie", "revoke"],
		] as const) {
			mock.timers.setTime(start);
			const issued = await issue(t, OWNER, carry === "cookie" ? "browser" : "device");
			const req = request(carrying(issued, carry));
			assert.deepEqual(await authenticate(t, req), OWNER);
			if (race === "revoke") await revoke(t, issued.id);
			else mock.timers.setTime(start + 401 * DAY);
			const { link, end } = await open(t, req);
			assert.deepEqual([link.closed, end], [1, undefined], `${carry}, ${race}`);
		}
	});

	it("a link without a token is none of the plugin's; one with a token that signs nobody in is closed", async () => {
		const { link, end } = await open(t, request({}));
		const refused = request({ authorization: "Bearer nope.x" });
		assert.equal(await authenticate(t, refused), undefined);
		const other = await open(t, refused);
		assert.deepEqual([link.closed, end, other.link.closed, other.end], [0, undefined, 1, undefined]);
	});

	// Astra, review of the base (2026-11-22): a link opened while the plugin reloaded, between its request's
	// authentication (the old object) and its open (the new one), was tracked by neither, so a revoke missed it.
	it("a link whose request another object of the plugin authenticated is still its sign-in's", async () => {
		const laptop = await issue(t, OWNER, "device");
		const req = request(carrying(laptop, "bearer"));
		// Opened without this object's authenticator having seen the request.
		const { link } = await open(t, req);
		await revoke(t, laptop.id);
		assert.equal(link.closed, 1);
	});

	it("keeps no request it authenticated: the note of a request's sign-in goes with the request", async () => {
		const issued = await issue(t, OWNER, "browser");
		const requests: WeakRef<HttpRequest>[] = [];
		const ends: (() => void)[] = [];
		await (async () => {
			for (const carry of ["bearer", "cookie"] as const) {
				for (let i = 0; i < 10; i++) {
					const req = request(carrying(issued, carry));
					requests.push(new WeakRef(req));
					assert.deepEqual(await authenticate(t, req), OWNER);
					// Half of them open a link that stays open: its closer holds no request either.
					if (i % 2 === 0) ends.push((await open(t, req)).end!);
				}
			}
		})();
		assert.ok(await collected(requests));
		assert.equal(ends.length, 10);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// The real server: HTTP requests, `/chord` links and the store's files.

/** The servers a case started, closed after it. */
const servers: TestServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close(context);
});

/** A test server with the probe, closed after the case. */
async function started(): Promise<TestServer> {
	const t = await testServer({ plugins: [PROBE] }, context);
	servers.push(t);
	return t;
}

/** A sign-in of `principal` on server `t`. */
function issueOn(t: TestServer, principal: P3Principal, kind: "browser" | "device"): Promise<Issued> {
	return t.host.root(
		async (ctx) => (await ctx.get(SignIns, {})).issue({ principal, label: "test", kind }, ctx),
		context,
	);
}

/** The probe route's answer to `headers` on `port`: 401 for nobody, else 200 with the principal they sign in as. */
function asked(port: number, headers: Readonly<Record<string, string>>): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/_probe/principal`, { headers });
}

/** The principal `headers` sign in as on `port`, or `undefined` (401). */
async function principalOf(port: number, headers: Readonly<Record<string, string>>): Promise<P3Principal | undefined> {
	const answer = await asked(port, headers);
	return answer.status === 401 ? undefined : ((await answer.json()) as P3Principal);
}

describe("the sign-in cookie on the server", () => {
	it("holds the Pi's id: two Pis on one host keep two cookies, and each takes only its own", async () => {
		const [one, other] = [await started(), await started()];
		const first = carrying(await issueOn(one, OWNER, "browser"), "cookie").cookie!;
		const second = carrying(await issueOn(other, OWNER, "browser"), "cookie").cookie!;
		assert.notEqual(first.split("=")[0], second.split("=")[0]);
		// A browser sends both to both ports.
		const both = { cookie: `${first}; ${second}` };
		assert.deepEqual([await principalOf(one.port, both), await principalOf(other.port, both)], [OWNER, OWNER]);
		assert.equal(await principalOf(other.port, { cookie: first }), undefined);
	});

	it("keeps the sign-ins and the cookie's key across a restart: a cookie and a token issued before still sign in", async () => {
		const t = await started();
		const browser = await issueOn(t, OWNER, "browser");
		const device = await issueOn(t, MAX, "device");
		const restarted = await servers.pop()!.restart(context);
		servers.push(restarted);
		const port = restarted.port;
		assert.deepEqual(
			[await principalOf(port, carrying(browser, "cookie")), await principalOf(port, carrying(device, "bearer"))],
			[OWNER, MAX],
		);
	});

	it("keeps only the token's hash in the store", async () => {
		const t = await started();
		const issued = await issueOn(t, OWNER, "device");
		await servers.pop()!.stop(context);
		const secret = issued.token.split(".")[1]!;
		const files = ["store.sqlite", "store.sqlite-wal"].map((name) =>
			readFile(join(t.dataDir, "server", name)).catch(() => Buffer.alloc(0)),
		);
		const stored = Buffer.concat(await Promise.all(files)).toString("latin1");
		await rm(t.dataDir, { recursive: true, force: true });
		assert.deepEqual(
			[stored.includes(secret), stored.includes(issued.token), stored.includes(hashToken(secret))],
			[false, false, true],
		);
	});
});

/** A device connected to `/chord` on `port` with `headers`: its host, and whether its socket has closed. */
async function device(port: number, headers: Readonly<Record<string, string>>) {
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols.
	const init = { headers } as unknown as string[];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	const state = { closed: false };
	socket.addEventListener("close", () => {
		state.closed = true;
	});
	// A call made while its link is down waits half a second at most.
	const host = createHost<P3Principal>({ readyTimeout: 500, onError: () => {} });
	host.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await host.load([], context);
	return { host, state };
}

/** Revokes `id` on `host`, then waits until `revoked`'s socket closed. */
async function revokeClosing(host: TestServer["host"], id: string, revoked: { closed: boolean }) {
	await host.root(async (ctx) => (await ctx.get(SignIns, {})).revoke(id, ctx), context);
	await eventually(
		async () => revoked.closed,
		(closed) => closed,
	);
}

describe("a sign-in's `/chord` links on the server", () => {
	it("a revoked sign-in's link closes at once; another device of the owner keeps its link and its objects", async () => {
		const t = await started();
		const owner = await ownerOf(t.host);
		const laptop = await issueOn(t, owner, "device");
		const phone = await issueOn(t, owner, "browser");
		const revoked = await device(t.port, carrying(laptop, "bearer"));
		const kept = await device(t.port, carrying(phone, "cookie"));
		try {
			const sessions = await revoked.host.get(Sessions, {}, context);
			const others = await kept.host.get(Sessions, {}, context);
			await sessions.create(coding("before"), context);
			await revokeClosing(t.host, laptop.id, revoked.state);
			await assert.rejects(sessions.create(coding("by a revoked device"), context));
			await others.create(coding("after"), context);
			assert.equal(kept.state.closed, false);
		} finally {
			await revoked.host.close(context);
			await kept.host.close(context);
		}
	});
});

describe("a reload of the sign-in plugin", () => {
	it("closes every link its `SignIns` tracked; after reconnecting, a revoke closes only the revoked device's", async () => {
		// A copy of the built-in plugins the test edits.
		const dir = await mkdtemp(join(tmpdir(), "p3-sign-in-reload-"));
		const root = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), root, { recursive: true });
		const t = await testServer({ builtIn: root }, context);
		const { host } = t;
		const owner = await ownerOf(host);
		const issue = (kind: "browser" | "device") =>
			host.root(
				async (ctx) => (await ctx.get(SignIns, {})).issue({ principal: owner, label: kind, kind }, ctx),
				context,
			);
		const laptop = await issue("device");
		const phone = await issue("browser");
		const devices: Awaited<ReturnType<typeof device>>[] = [];
		const connect = async () => {
			const pair = [
				await device(t.port, carrying(laptop, "bearer")),
				await device(t.port, carrying(phone, "cookie")),
			];
			devices.push(...pair);
			await Promise.all(pair.map(({ host: client }) => client.get(Sessions, {}, context)));
			return pair;
		};
		try {
			const before = await connect();
			// A real edit of the plugin's code (one its build keeps: a label), applied as `p3 apply` does; the watcher
			// sees it a moment later.
			const file = join(root, "sign-in", "owner.ts");
			const source = await readFile(file, "utf8");
			assert.ok(source.includes('"owner browser"'));
			await writeFile(file, source.replace('"owner browser"', '"owner browser, edited"'));
			await eventually(
				async () => {
					await t.apply(context);
					return before.map(({ state }) => state.closed);
				},
				(closed) => closed.every(Boolean),
			);
			// The sign-ins stay: both devices sign in again, and a revoke reaches the new object's links.
			const [revoked, kept] = await connect();
			await revokeClosing(host, laptop.id, revoked!.state);
			await (await kept!.host.get(Sessions, {}, context)).create(coding("after"), context);
			assert.equal(kept!.state.closed, false);
			assert.deepEqual(t.errors, []);
		} finally {
			for (const { host: client } of devices) await client.close(context);
			await t.close(context);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
