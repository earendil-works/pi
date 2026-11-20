// Tests of sign-ins: issue, revoke and list through `SignIns`; tokens kept only as hashes; the authenticator taking a
// bearer token or the signed sign-in cookie, named after the Pi; the cookie renewed once it is a day old; a sign-in
// ending unused; a revoked sign-in's open links closed, and only its own.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createHost, isChordError, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Authenticator, Authenticators } from "@earendil-works/chord/http";
import type { P3Principal } from "@earendil-works/p3/v1";
import { CODING, Sessions, SessionsList } from "../../plugins/sessions/contract.ts";
import type { App } from "../../src/kit/app.ts";
import { readConfig } from "../../src/kit/config.ts";
import { hashToken } from "../../src/kit/secrets.ts";
import { SignIns } from "../../src/kit/sign-ins.ts";
import { kitApp, send, WHOAMI } from "./support.ts";

const DAY = 24 * 60 * 60_000;

const MAX: P3Principal = { kind: "person", id: "max", name: "Max" };

/** A server with the whoami plugin. */
function withWhoami() {
	return kitApp({ plugins: { whoami: { "server.ts": WHOAMI } } });
}

/** A new sign-in of `principal` on `app`. */
function issue(app: App, principal: P3Principal, kind: "browser" | "device", label = "test") {
	return app.host.root(async (ctx) => (await ctx.get(SignIns, {})).issue({ principal, label, kind }, ctx), context);
}

/** `GET /whoami` with `headers`. */
function whoami(port: number, headers: Readonly<Record<string, string>>) {
	return send(port, "GET", "/whoami", { headers });
}

afterEach(() => mock.timers.reset());

setFlagsFromString("--expose-gc");
/** Collects garbage now. */
const gc = runInNewContext("gc") as () => void;

describe("issuing, listing and revoking", () => {
	it("issues a sign-in whose token authenticates as a bearer and as the cookie, lists it without its hash, revokes it", async () => {
		const { app, port } = await withWhoami();
		const issued = await issue(app, MAX, "device", "Max's laptop");
		assert.match(issued.token, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		const bearer = await whoami(port, { authorization: `Bearer ${issued.token}` });
		assert.deepEqual(JSON.parse(bearer.body), MAX);
		assert.match(issued.cookie, /^p3-[0-9a-f]{16}=[^;]+; HttpOnly; Path=\/; SameSite=Strict; Max-Age=34560000$/);
		const browser = await whoami(port, { cookie: issued.cookie.split(";")[0]! });
		assert.deepEqual(JSON.parse(browser.body), MAX);
		const listed = await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).list.value, context);
		const { created, lastUsed, ...shown } = listed.find(({ id }) => id === issued.id)!;
		assert.deepEqual(shown, { id: issued.id, label: "Max's laptop", kind: "device", principal: MAX });
		assert.deepEqual([typeof created, typeof lastUsed], ["number", "number"]);
		await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).revoke(issued.id, ctx), context);
		assert.equal((await whoami(port, { authorization: `Bearer ${issued.token}` })).status, 401);
	});

	it("issues a sign-in only for one of p3's principals", async () => {
		const { app } = await withWhoami();
		// A value from outside the types, as a caller without type checks passes it.
		const admin = { kind: "admin" } as unknown as P3Principal;
		await assert.rejects(issue(app, admin, "device"), (error) => isChordError(error, "invalid"));
	});

	it("refuses a token with a wrong secret, an unknown id and a forged cookie", async () => {
		const { app, port } = await withWhoami();
		const issued = await issue(app, { kind: "owner" }, "device");
		const [id, secret] = issued.token.split(".");
		for (const token of [`${id}.wrong`, `nope.${secret}`, "garbage"]) {
			assert.equal((await whoami(port, { authorization: `Bearer ${token}` })).status, 401);
		}
		const name = issued.cookie.split("=")[0]!;
		assert.equal((await whoami(port, { cookie: `${name}=${issued.token}.x.y` })).status, 401);
	});

	it("keeps only the token's hash in the store", async () => {
		const { app, dataDir } = await withWhoami();
		const issued = await issue(app, { kind: "owner" }, "device");
		await app.close(context);
		const secret = issued.token.split(".")[1]!;
		const files = ["store.sqlite", "store.sqlite-wal"].map((name) =>
			readFile(join(dataDir, "server", name)).catch(() => Buffer.alloc(0)),
		);
		const stored = Buffer.concat(await Promise.all(files)).toString("latin1");
		assert.deepEqual([stored.includes(secret), stored.includes(hashToken(secret))], [false, true]);
	});
});

describe("the cookie's name", () => {
	it("holds the Pi's id: two Pis on one host keep two cookies, and each takes only its own", async () => {
		const [one, other] = await Promise.all([withWhoami(), withWhoami()]);
		const cookieOf = async ({ app }: { app: App }) => (await issue(app, MAX, "browser")).cookie.split(";")[0]!;
		const [first, second] = [await cookieOf(one), await cookieOf(other)];
		const { id } = (await readConfig(join(one.dataDir, "pi.json")))!;
		assert.equal(first.split("=")[0], `p3-${id}`);
		assert.notEqual(first.split("=")[0], second.split("=")[0]);
		// A browser sends both to both ports.
		const both = { cookie: `${first}; ${second}` };
		assert.deepEqual([(await whoami(one.port, both)).status, (await whoami(other.port, both)).status], [200, 200]);
		assert.equal((await whoami(other.port, { cookie: first })).status, 401);
	});
});

describe("rolling cookies", () => {
	it("renews a browser's sign-in cookie once it is older than a day, with a fresh signed expiry", async () => {
		const { app, port } = await withWhoami();
		const issued = await issue(app, { kind: "owner" }, "browser");
		const cookie = issued.cookie.split(";")[0]!;
		// Within the day: nothing set.
		assert.equal((await whoami(port, { cookie })).headers["set-cookie"], undefined);
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start + 2 * DAY });
		const renewed = await whoami(port, { cookie });
		assert.equal(renewed.status, 200);
		const set = String(renewed.headers["set-cookie"]);
		assert.match(set, /^p3-[0-9a-f]{16}=[^;]+; HttpOnly; Path=\/; SameSite=Strict; Max-Age=34560000$/);
		const expires = Number(set.split(";")[0]!.split(".").at(-2)) * 1000;
		assert.ok(expires > start + 401 * DAY);
		// 399 days later the old cookie has expired, the renewed one still signs in.
		mock.timers.setTime(start + 401 * DAY);
		assert.equal((await whoami(port, { cookie })).status, 401);
		assert.equal((await whoami(port, { cookie: set.split(";")[0]! })).status, 200);
	});

	it("does not renew a revoked sign-in's cookie", async () => {
		const { app, port } = await withWhoami();
		const browser = await issue(app, { kind: "owner" }, "browser");
		await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).revoke(browser.id, ctx), context);
		mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * DAY });
		const revoked = await whoami(port, { cookie: browser.cookie.split(";")[0]! });
		assert.deepEqual([revoked.status, revoked.headers["set-cookie"]], [401, undefined]);
	});
});

describe("expiry and malformed tokens", () => {
	it("ends a sign-in unused for 400 days, at its next use", async () => {
		const { app, port } = await withWhoami();
		const { token } = await issue(app, { kind: "owner" }, "device", "d");
		mock.timers.enable({ apis: ["Date"], now: Date.now() + 400 * DAY + 1 });
		assert.equal((await whoami(port, { authorization: `Bearer ${token}` })).status, 401);
		mock.timers.reset();
		const signIns = await app.host.get(SignIns, {}, context);
		const listed = () => signIns.list.value.some(({ label }) => label === "d");
		for (let waited = 0; listed() && waited < 2000; waited += 10) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(listed(), false);
		signIns.release();
	});

	it("answers a malformed token or a prototype key as an id with a plain 401, reporting nothing", async () => {
		const { port, errors, dataDir } = await withWhoami();
		for (const token of ["constructor.x", "__proto__.x", "toString.x", "hasOwnProperty.x", ".x", "x", "a.b.c"]) {
			assert.equal((await whoami(port, { authorization: `Bearer ${token}` })).status, 401, token);
		}
		const { id } = (await readConfig(join(dataDir, "pi.json")))!;
		assert.equal((await whoami(port, { cookie: `p3-${id}=__proto__.x` })).status, 401);
		assert.deepEqual(errors, []);
	});
});

/** What a sign-in's device sends: its bearer token, or its cookie as a browser does. */
function credentials(
	issued: { readonly token: string; readonly cookie: string },
	carry: "bearer" | "cookie",
): Record<string, string> {
	return carry === "bearer" ? { authorization: `Bearer ${issued.token}` } : { cookie: issued.cookie.split(";")[0]! };
}

/** A device connected over WebSocket with `headers`: its host, and whether its socket has closed. */
async function device(port: number, headers: Readonly<Record<string, string>>) {
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols, hence the cast.
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

describe("a revoked sign-in's links", () => {
	it("are closed at once; the owner's other devices keep their links, their objects and their references", async () => {
		const root = fileURLToPath(new URL("../../plugins/", import.meta.url));
		const { app, port } = await kitApp({ root });
		// A command-line client with its token, and a browser with its cookie.
		const laptop = await issue(app, { kind: "owner" }, "device");
		const phone = await issue(app, { kind: "owner" }, "browser");
		const revoked = await device(port, credentials(laptop, "bearer"));
		const kept = await device(port, credentials(phone, "cookie"));
		try {
			const active = { app: CODING, set: "active", view: "kept" } as const;
			const sessions = await revoked.host.get(Sessions, {}, context);
			const others = await kept.host.get(Sessions, {}, context);
			const list = await kept.host.get(SessionsList, active, context);
			const before = await sessions.create({ title: "before" }, context);
			await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).revoke(laptop.id, ctx), context);
			// The revoked device's socket is gone, and what it calls now creates nothing.
			for (let waited = 0; !revoked.state.closed && waited < 2000; waited += 5) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.equal(revoked.state.closed, true);
			await assert.rejects(sessions.create({ title: "by a revoked device" }, context), (error) =>
				isChordError(error, "unavailable"),
			);
			// The other device shares the owner's `Sessions` object on the server: it was not ended with the sign-in.
			const after = await others.create({ title: "after" }, context);
			assert.deepEqual([kept.state.closed, others.state.value.kind, list.state.value.kind], [false, "live", "live"]);
			assert.deepEqual(list.list.value.rows.map((row) => row.id).sort(), [after, before].sort());
		} finally {
			await revoked.host.close(context);
			await kept.host.close(context);
		}
	});

	it("are closed at once when the sign-in ended between its authentication and the link's registration", async () => {
		// Review round 2 (Sol's and Astra's reproductions): the upgrade is asynchronous, so a sign-in can end after the
		// authenticator answered and before the kit hears of the link. The test forces that order: it wraps the kit's
		// authenticator so that a request marked `x-race` is revoked, or outlives its 400 days (its cookie's too),
		// right after it authenticated; with a bearer token and with a cookie.
		const root = fileURLToPath(new URL("../../plugins/", import.meta.url));
		const { app, port } = await kitApp({ root });
		const owner: P3Principal = { kind: "owner" };
		const authenticators = await app.host.registry(Authenticators, context);
		// The composed entry is replaced for this test only: a scheduling hook, restored below.
		const found = authenticators.value.find(({ plugin }) => plugin === "p3.sign-ins");
		const entry = found as { authenticate: Authenticator };
		const original = entry.authenticate;
		entry.authenticate = async (request, ctx) => {
			const principal = await original(request, ctx);
			const [race, id] = (request.headers.get("x-race") ?? "").split(" ");
			if (race === "revoke") {
				await app.host.root(async (scope) => (await scope.get(SignIns, {})).revoke(id!, scope), context);
			}
			if (race === "expire") mock.timers.enable({ apis: ["Date"], now: Date.now() + 401 * DAY });
			return principal;
		};
		const kept = await device(port, credentials(await issue(app, owner, "device"), "bearer"));
		try {
			for (const [carry, race] of [
				["bearer", "revoke"],
				["bearer", "expire"],
				["cookie", "revoke"],
				["cookie", "expire"],
			] as const) {
				const issued = await issue(app, owner, carry === "cookie" ? "browser" : "device");
				const raced = await device(port, { ...credentials(issued, carry), "x-race": `${race} ${issued.id}` });
				for (let waited = 0; !raced.state.closed && waited < 400; waited += 1) {
					await new Promise((resolve) => setImmediate(resolve));
				}
				mock.timers.reset();
				assert.equal(raced.state.closed, true, `${carry}, ${race}`);
				await raced.host.close(context);
			}
			// The owner's other device signed in before and is untouched.
			const others = await kept.host.get(Sessions, {}, context);
			await others.create({ title: "by the other device" }, context);
			assert.equal(kept.state.closed, false);
		} finally {
			entry.authenticate = original;
			await kept.host.close(context);
		}
	});
});

describe("GC", () => {
	it("keeps no request it authenticated: the note of a request's sign-in goes with the request", async () => {
		const { app, port } = await withWhoami();
		const issued = await issue(app, { kind: "owner" }, "browser");
		const authenticators = await app.host.registry(Authenticators, context);
		// The composed entry is replaced for this test only, to see each request the kit authenticates; restored below.
		const found = authenticators.value.find(({ plugin }) => plugin === "p3.sign-ins");
		const entry = found as { authenticate: Authenticator };
		const original = entry.authenticate;
		const requests: WeakRef<object>[] = [];
		entry.authenticate = (request, ctx) => {
			requests.push(new WeakRef(request));
			return original(request, ctx);
		};
		try {
			for (const carry of ["bearer", "cookie"] as const) {
				for (let i = 0; i < 10; i++) {
					const headers = { ...credentials(issued, carry), connection: "close" };
					assert.equal((await send(port, "GET", "/whoami", { headers })).status, 200);
				}
				// A link too: its request is authenticated, and the kit hears of the link by it.
				const seen = requests.length;
				const linked = await device(port, credentials(issued, carry));
				for (let waited = 0; requests.length === seen && waited < 2000; waited += 5) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
				await linked.host.close(context);
			}
			assert.equal(requests.length, 22);
			for (let round = 0; round < 20 && requests.some((request) => request.deref() !== undefined); round++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				gc();
			}
			assert.deepEqual(
				requests.map((request) => request.deref() === undefined),
				requests.map(() => true),
			);
		} finally {
			entry.authenticate = original;
		}
	});
});
