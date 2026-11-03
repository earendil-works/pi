// Tests of sessions (slice 13 §2): issue, revoke and list through `Sessions`; tokens kept only as hashes; the
// authenticator taking a bearer token or the signed session cookie; ephemeral sessions dropped when the server starts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Sessions } from "../../../src/node/app/index.ts";
import { hashToken } from "../../../src/node/app/secrets.ts";
import { send } from "../http/support.ts";
import { testApp, WHOAMI } from "./support.ts";

/** The app with the whoami plugin (its API's server module gives `Http`). */
async function withWhoami() {
	return testApp({ plugins: { whoami: { "server.ts": WHOAMI } } });
}

describe("issuing, listing and revoking", () => {
	it("issues a session whose token authenticates as a bearer and as the cookie, lists it without its hash, revokes it", async () => {
		const { app, port } = await withWhoami();
		const issued = await app.host.root(async (ctx) => {
			const sessions = await ctx.get(Sessions, {});
			return sessions.issue(
				{ principal: { kind: "user", id: "u1", name: "ada" }, label: "ada's laptop", kind: "device" },
				ctx,
			);
		}, context);
		expect(issued.token).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		const bearer = await send(port, "GET", "/whoami", { headers: { authorization: `Bearer ${issued.token}` } });
		expect(JSON.parse(bearer.body.toString())).toEqual({ kind: "user", id: "u1", name: "ada" });
		const cookie = issued.cookie.split(";")[0]!;
		expect(issued.cookie).toMatch(/^chord-session=[^;]+; HttpOnly; Path=\/; SameSite=Strict; Max-Age=34560000$/);
		const browser = await send(port, "GET", "/whoami", { headers: { cookie } });
		expect(JSON.parse(browser.body.toString())).toMatchObject({ id: "u1" });
		const listed = await app.host.root(async (ctx) => (await ctx.get(Sessions, {})).list.value, context);
		expect(listed.find(({ id }) => id === issued.id)).toEqual({
			id: issued.id,
			label: "ada's laptop",
			kind: "device",
			principal: { kind: "user", id: "u1", name: "ada" },
			created: expect.any(Number),
			lastUsed: expect.any(Number),
		});
		await app.host.root(async (ctx) => (await ctx.get(Sessions, {})).revoke(issued.id, ctx), context);
		expect(
			(await send(port, "GET", "/whoami", { headers: { authorization: `Bearer ${issued.token}` } })).status,
		).toBe(401);
		await app.close(context);
	});

	it("refuses a token with a wrong secret, an unknown id and a forged cookie", async () => {
		const { app, port } = await withWhoami();
		const issued = await app.host.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).issue({ principal: { kind: "owner" }, label: "x", kind: "device" }, ctx),
			context,
		);
		const [id] = issued.token.split(".");
		for (const token of [`${id}.wrong`, `nope.${issued.token.split(".")[1]}`, "garbage"]) {
			expect((await send(port, "GET", "/whoami", { headers: { authorization: `Bearer ${token}` } })).status).toBe(
				401,
			);
		}
		expect(
			(await send(port, "GET", "/whoami", { headers: { cookie: `chord-session=${issued.token}.x.y` } })).status,
		).toBe(401);
		await app.close(context);
	});

	it("keeps only the token's hash in the store", async () => {
		const { app, dataDir } = await withWhoami();
		const issued = await app.host.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).issue({ principal: { kind: "owner" }, label: "x", kind: "device" }, ctx),
			context,
		);
		await app.close(context);
		const secret = issued.token.split(".")[1]!;
		const stored = Buffer.concat(
			await Promise.all(
				["store.sqlite", "store.sqlite-wal"].map((name) =>
					readFile(join(dataDir, "server", name)).catch(() => Buffer.alloc(0)),
				),
			),
		).toString("latin1");
		expect(stored.includes(secret)).toBe(false);
		expect(stored.includes(hashToken(secret))).toBe(true);
	});
});

describe("ephemeral sessions", () => {
	it("authenticate in memory, are not listed, and end with the server; persisted ones stay", async () => {
		const first = await withWhoami();
		const issued = await first.app.host.root(async (ctx) => {
			const sessions = await ctx.get(Sessions, {});
			const principal = { kind: "user", id: "e", name: "e" };
			const ephemeral = await sessions.issue({ principal, label: "e", kind: "ephemeral" }, ctx);
			const device = await sessions.issue({ principal: { kind: "owner" }, label: "d", kind: "device" }, ctx);
			return { ephemeral, device, listed: sessions.list.value.map(({ id }) => id) };
		}, context);
		expect(issued.listed).toEqual(expect.arrayContaining([issued.device.id]));
		expect(issued.listed).not.toContain(issued.ephemeral.id);
		const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
		expect((await send(first.port, "GET", "/whoami", bearer(issued.ephemeral.token))).status).toBe(200);
		await first.app.close(context);
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		expect((await send(second.port, "GET", "/whoami", bearer(issued.ephemeral.token))).status).toBe(401);
		expect((await send(second.port, "GET", "/whoami", bearer(issued.device.token))).status).toBe(200);
		await second.app.close(context);
	});

	it("live at most `limits.ephemeralSessions`: past it the oldest ends; an issue costs the same whatever came before", async () => {
		const { app, port } = await testApp({
			limits: { ephemeralSessions: 3 },
			plugins: { whoami: { "server.ts": WHOAMI } },
		});
		const sessions = await app.host.get(Sessions, {}, context);
		const issue = (index: number) =>
			sessions.issue(
				{ principal: { kind: "user", id: `u${index}`, name: "u" }, label: "u", kind: "ephemeral" },
				context,
			);
		const tokens = [];
		for (let index = 0; index < 4; index++) tokens.push((await issue(index)).token);
		const status = async (token: string) =>
			(await send(port, "GET", "/whoami", { headers: { authorization: `Bearer ${token}` } })).status;
		expect(await Promise.all(tokens.map(status))).toEqual([401, 200, 200, 200]);
		// Many more: the cap holds them, and nothing is persisted (no document grows).
		for (let index = 4; index < 2000; index++) await issue(index);
		expect(sessions.list.value.filter(({ kind }) => kind !== "browser" && kind !== "device")).toEqual([]);
		sessions.release();
		await app.close(context);
	});
});

describe("rolling cookies", () => {
	it("renews a browser's session cookie once it is older than a day, with a fresh signed expiry (recheck N3)", async () => {
		const { app, port } = await withWhoami();
		const issued = await app.host.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).issue({ principal: { kind: "owner" }, label: "b", kind: "browser" }, ctx),
			context,
		);
		const cookie = issued.cookie.split(";")[0]!;
		const whoami = async (header: string) => send(port, "GET", "/whoami", { headers: { cookie: header } });
		// Within the day: nothing set.
		expect((await whoami(cookie)).headers["set-cookie"]).toBeUndefined();
		const start = Date.now();
		vi.useFakeTimers({ toFake: ["Date"], now: start + 2 * 24 * 60 * 60_000 });
		try {
			const renewed = await whoami(cookie);
			expect(renewed.status).toBe(200);
			const set = String(renewed.headers["set-cookie"]);
			expect(set).toMatch(/^chord-session=[^;]+; HttpOnly; Path=\/; SameSite=Strict; Max-Age=34560000$/);
			const expires = Number(set.split(";")[0]!.split(".").at(-2)) * 1000;
			expect(expires).toBeGreaterThan(start + 401 * 24 * 60 * 60_000);
			// 399 days later the old cookie has expired, the renewed one still signs in.
			vi.setSystemTime(start + 401 * 24 * 60 * 60_000);
			expect((await whoami(cookie)).status).toBe(401);
			expect((await whoami(set.split(";")[0]!)).status).toBe(200);
		} finally {
			vi.useRealTimers();
		}
		await app.close(context);
	});

	it("does not renew an ephemeral session's cookie, nor a revoked session's", async () => {
		const { app, port } = await withWhoami();
		const sessions = await app.host.get(Sessions, {}, context);
		const ephemeral = await sessions.issue(
			{ principal: { kind: "user", id: "e", name: "e" }, label: "e", kind: "ephemeral" },
			context,
		);
		const browser = await sessions.issue({ principal: { kind: "owner" }, label: "b", kind: "browser" }, context);
		await sessions.revoke(browser.id, context);
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 24 * 60 * 60_000 });
		try {
			const short = await send(port, "GET", "/whoami", { headers: { cookie: ephemeral.cookie.split(";")[0]! } });
			expect([short.status, short.headers["set-cookie"]]).toEqual([200, undefined]);
			const revoked = await send(port, "GET", "/whoami", { headers: { cookie: browser.cookie.split(";")[0]! } });
			expect([revoked.status, revoked.headers["set-cookie"]]).toEqual([401, undefined]);
		} finally {
			vi.useRealTimers();
		}
		sessions.release();
		await app.close(context);
	});
});

describe("expiry and malformed tokens", () => {
	it("ends a persisted session unused for 400 days, at its next use", async () => {
		const { app, port } = await withWhoami();
		const { token } = await app.host.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).issue({ principal: { kind: "owner" }, label: "d", kind: "device" }, ctx),
			context,
		);
		const now = Date.now();
		vi.useFakeTimers({ toFake: ["Date"], now: now + 400 * 24 * 60 * 60_000 + 1 });
		try {
			expect((await send(port, "GET", "/whoami", { headers: { authorization: `Bearer ${token}` } })).status).toBe(
				401,
			);
		} finally {
			vi.useRealTimers();
		}
		const sessions = await app.host.get(Sessions, {}, context);
		while (sessions.list.value.some(({ label }) => label === "d"))
			await new Promise((resolve) => setTimeout(resolve, 10));
		sessions.release();
		await app.close(context);
	});

	it("answers a malformed token or a prototype key as an id with a plain 401, reporting nothing", async () => {
		const { app, port, errors } = await withWhoami();
		for (const token of ["constructor.x", "__proto__.x", "toString.x", "hasOwnProperty.x", ".x", "x", "a.b.c"]) {
			expect((await send(port, "GET", "/whoami", { headers: { authorization: `Bearer ${token}` } })).status).toBe(
				401,
			);
		}
		expect((await send(port, "GET", "/whoami", { headers: { cookie: "chord-session=__proto__.x" } })).status).toBe(
			401,
		);
		expect(errors).toEqual([]);
		await app.close(context);
	});
});
