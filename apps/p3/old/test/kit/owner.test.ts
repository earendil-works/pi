// Tests of the owner's sign-in: the owner link (single use, expiry, replaced at each start and on the owner's
// request, the token only in the fragment) and the owner token file (mode 0600, kept while its sign-in lives,
// replaced once it no longer signs in).

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, it, mock } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { OwnerLink } from "../../src/kit/owner.ts";
import { SignIns } from "../../src/kit/sign-ins.ts";
import { kitApp, send, WHOAMI } from "./support.ts";

/** Posts `token` to the owner route as the link's page does. */
function postToken(port: number, token: string) {
	const headers = { "content-type": "application/json" };
	return send(port, "POST", "/_p3/owner", { headers, body: JSON.stringify({ token }) });
}

afterEach(() => mock.timers.reset());

describe("the owner link", () => {
	it("serves a page reading the fragment, signs the owner in once, and refuses the token a second time", async () => {
		const { app, port } = await kitApp({ plugins: { whoami: { "server.ts": WHOAMI } } });
		assert.equal((await send(port, "GET", "/whoami")).status, 401);
		const link = new URL(app.ownerLink());
		assert.equal(link.pathname, "/_p3/owner");
		const page = await send(port, "GET", link.pathname);
		assert.equal(page.status, 200);
		assert.ok(page.body.includes("location.hash"));
		const token = link.hash.slice(1);
		const signed = await postToken(port, token);
		assert.equal(signed.status, 200);
		const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
		const whoami = await send(port, "GET", "/whoami", { headers: { cookie } });
		assert.deepEqual(JSON.parse(whoami.body), { kind: "owner" });
		assert.equal((await postToken(port, token)).status, 403);
		const listed = await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).list.value, context);
		assert.deepEqual(
			listed.filter(({ kind }) => kind === "browser").map(({ label }) => label),
			["owner browser"],
		);
	});

	it("refuses an expired token, a wrong one, and the previous start's", () => {
		mock.timers.enable({ apis: ["Date"] });
		const link = new OwnerLink();
		assert.throws(() => link.renew(), /the server has not started/);
		link.listening({ host: "127.0.0.1", port: 1 });
		const renew = () => new URL(link.renew()).hash.slice(1);
		const expiring = renew();
		mock.timers.tick(10 * 60_000);
		assert.equal(link.consume(expiring), false);
		const previous = renew();
		const current = renew();
		assert.deepEqual([link.consume(previous), link.consume("x".repeat(43))], [false, false]);
		mock.timers.tick(10 * 60_000 - 1);
		assert.deepEqual([link.consume(current), link.consume(current)], [true, false]);
	});

	it("gives a new link at each start; the old one no longer signs in", async () => {
		const first = await kitApp();
		const old = new URL(first.app.ownerLink()).hash.slice(1);
		await first.app.close(context);
		const second = await kitApp({ dataDir: first.dataDir, root: first.root });
		assert.notEqual(new URL(second.app.ownerLink()).hash.slice(1), old);
		assert.equal((await postToken(second.port, old)).status, 403);
	});
});

describe("a fresh owner link", () => {
	it("is given to the owner's token only; it signs in once and ends the link before it", async () => {
		const { app, port } = await kitApp();
		const ask = (headers: Record<string, string>) => send(port, "POST", "/_p3/owner/link", { headers });
		assert.equal((await ask({})).status, 401);
		const person = { principal: { kind: "person", id: "max", name: "Max" }, label: "Max", kind: "device" } as const;
		const max = await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).issue(person, ctx), context);
		assert.equal((await ask({ authorization: `Bearer ${max.token}` })).status, 403);
		const owner = (await readFile(app.ownerTokenFile, "utf8")).trim();
		const answered = await ask({ authorization: `Bearer ${owner}` });
		assert.equal(answered.status, 200);
		const fresh = new URL((JSON.parse(answered.body) as { link: string }).link);
		assert.deepEqual([fresh.port, fresh.pathname], [String(port), "/_p3/owner"]);
		// The start's link is dropped; the fresh one works once.
		assert.equal((await postToken(port, new URL(app.ownerLink()).hash.slice(1))).status, 403);
		assert.equal((await postToken(port, fresh.hash.slice(1))).status, 200);
		assert.equal((await postToken(port, fresh.hash.slice(1))).status, 403);
	});
});

describe("the owner token file", () => {
	it("is written at first start with mode 0600, signs in as the owner, and is kept across starts", async () => {
		const first = await kitApp({ plugins: { whoami: { "server.ts": WHOAMI } } });
		const file = first.app.ownerTokenFile;
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		const token = (await readFile(file, "utf8")).trim();
		const whoami = await send(first.port, "GET", "/whoami", { headers: { authorization: `Bearer ${token}` } });
		assert.deepEqual(JSON.parse(whoami.body), { kind: "owner" });
		await first.app.close(context);
		await kitApp({ dataDir: first.dataDir, root: first.root });
		assert.equal((await readFile(file, "utf8")).trim(), token);
	});

	it("is replaced at the next start when its secret no longer matches its sign-in", async () => {
		const first = await kitApp();
		const file = first.app.ownerTokenFile;
		const token = (await readFile(file, "utf8")).trim();
		await first.app.close(context);
		const damaged = `${token.slice(0, token.indexOf("."))}.${"x".repeat(43)}`;
		await writeFile(file, `${damaged}\n`, { mode: 0o600 });
		await kitApp({ dataDir: first.dataDir, root: first.root });
		const replaced = (await readFile(file, "utf8")).trim();
		assert.deepEqual([replaced === damaged, replaced === token], [false, false]);
	});

	it("is replaced at the next start once its sign-in was revoked", async () => {
		const first = await kitApp();
		const file = first.app.ownerTokenFile;
		const token = (await readFile(file, "utf8")).trim();
		const id = token.slice(0, token.indexOf("."));
		await first.app.host.root(async (ctx) => (await ctx.get(SignIns, {})).revoke(id, ctx), context);
		await first.app.close(context);
		await kitApp({ dataDir: first.dataDir, root: first.root });
		assert.notEqual((await readFile(file, "utf8")).trim(), token);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	});
});
