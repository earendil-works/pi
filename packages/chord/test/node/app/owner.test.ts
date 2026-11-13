// Tests of the owner's sign-in (slice 13 §2): the owner link (single use, expiry, replaced at each start, the token
// only in the fragment), the owner token file (mode 0600, kept while its sign-in lives, replaced once revoked), and an
// owner the app chooses (decision "The kit's owner is a principal the app chooses": recognized by canonical JSON, its
// token file replaced and its sign-in revoked when it changes).

import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { SignIns } from "../../../src/node/app/index.ts";
import { OwnerLink } from "../../../src/node/app/owner.ts";
import { send } from "../http/support.ts";
import { bearerFor, testApp, type UserPrincipal, userOwnerApp, WHOAMI } from "./support.ts";

/** Posts `token` to the owner route as the link's page does. */
function postToken(port: number, token: string) {
	return send(port, "POST", "/_chord/owner", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the owner link", () => {
	it("serves a page reading the fragment, signs the owner in once, and refuses the token a second time", async () => {
		const { app, port } = await testApp({ plugins: { whoami: { "server.ts": WHOAMI } } });
		expect((await send(port, "GET", "/whoami")).status).toBe(401);
		const link = new URL(app.ownerLink());
		expect(link.pathname).toBe("/_chord/owner");
		const page = await send(port, "GET", link.pathname);
		expect(page.status).toBe(200);
		expect(page.body.toString()).toContain("location.hash");
		const token = link.hash.slice(1);
		const signed = await postToken(port, token);
		expect(signed.status).toBe(200);
		const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
		const whoami = await send(port, "GET", "/whoami", { headers: { cookie } });
		expect(JSON.parse(whoami.body.toString())).toEqual({ kind: "owner" });
		expect((await postToken(port, token)).status).toBe(403);
		const listed = await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).list.value, context);
		expect(listed.filter(({ kind }) => kind === "browser").map(({ label }) => label)).toEqual(["owner browser"]);
		await app.close(context);
	});

	it("refuses an expired token, a wrong one, and the previous start's", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const link = new OwnerLink();
		const expiring = link.renew();
		vi.advanceTimersByTime(10 * 60_000);
		expect(link.consume(expiring)).toBe(false);
		const previous = link.renew();
		const current = link.renew();
		expect(link.consume(previous)).toBe(false);
		expect(link.consume("x".repeat(43))).toBe(false);
		vi.advanceTimersByTime(10 * 60_000 - 1);
		expect(link.consume(current)).toBe(true);
		expect(link.consume(current)).toBe(false);
	});

	it("gives a new link at each start; the old one no longer signs in", async () => {
		const first = await testApp();
		const old = new URL(first.app.ownerLink()).hash.slice(1);
		await first.app.close(context);
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		expect(new URL(second.app.ownerLink()).hash.slice(1)).not.toBe(old);
		expect((await postToken(second.port, old)).status).toBe(403);
		await second.app.close(context);
	});
});

describe("the owner token file", () => {
	it("is written at first start with mode 0600, signs in as the owner, and is kept across starts", async () => {
		const first = await testApp({ plugins: { whoami: { "server.ts": WHOAMI } } });
		const file = first.app.ownerTokenFile;
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const token = (await readFile(file, "utf8")).trim();
		const whoami = await send(first.port, "GET", "/whoami", { headers: { authorization: `Bearer ${token}` } });
		expect(JSON.parse(whoami.body.toString())).toEqual({ kind: "owner" });
		await first.app.close(context);
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		expect((await readFile(file, "utf8")).trim()).toBe(token);
		await second.app.close(context);
	});

	it("is replaced at the next start when its secret no longer matches its sign-in (review L6)", async () => {
		const first = await testApp();
		const token = (await readFile(first.app.ownerTokenFile, "utf8")).trim();
		await first.app.close(context);
		const damaged = `${token.slice(0, token.indexOf("."))}.${"x".repeat(43)}`;
		await writeFile(first.app.ownerTokenFile, `${damaged}\n`, { mode: 0o600 });
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		const replaced = (await readFile(second.app.ownerTokenFile, "utf8")).trim();
		expect([replaced === damaged, replaced === token]).toEqual([false, false]);
		await second.app.close(context);
	});

	it("is replaced at the next start once its sign-in was revoked", async () => {
		const first = await testApp();
		const token = (await readFile(first.app.ownerTokenFile, "utf8")).trim();
		await first.app.host.root(async (ctx) => {
			const signIns = await ctx.get(SignIns, {});
			const id = token.slice(0, token.indexOf("."));
			await signIns.revoke(id, ctx);
		}, context);
		await first.app.close(context);
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		const replaced = (await readFile(second.app.ownerTokenFile, "utf8")).trim();
		expect(replaced).not.toBe(token);
		expect((await stat(second.app.ownerTokenFile)).mode & 0o777).toBe(0o600);
		await second.app.close(context);
	});
});

describe("an owner the app chooses", () => {
	const ada: UserPrincipal = { kind: "user", id: "u1" };
	const bob: UserPrincipal = { kind: "user", id: "u2" };

	/** Who `headers` sign in as on `port` (`GET /whoami`). */
	async function whoami(port: number, headers: Readonly<Record<string, string>>): Promise<unknown> {
		return JSON.parse((await send(port, "GET", "/whoami", { headers })).body.toString());
	}

	it("signs the owner link and the owner token file in as that principal", async () => {
		const { app, port } = await userOwnerApp(ada, { plugins: { whoami: { "server.ts": WHOAMI } } });
		const signed = await postToken(port, new URL(app.ownerLink()).hash.slice(1));
		const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
		expect(await whoami(port, { cookie })).toEqual(ada);
		const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
		expect(await whoami(port, { authorization: `Bearer ${token}` })).toEqual(ada);
		await app.close(context);
	});

	it("keeps a user owner's token file across starts, also with the owner's fields in another order", async () => {
		const first = await userOwnerApp(ada);
		const token = (await readFile(first.app.ownerTokenFile, "utf8")).trim();
		await first.app.close(context);
		const second = await userOwnerApp({ id: "u1", kind: "user" }, { dataDir: first.dataDir, root: first.root });
		expect((await readFile(second.app.ownerTokenFile, "utf8")).trim()).toBe(token);
		await second.app.close(context);
	});

	it("replaces the owner token file when the owner changes and revokes its sign-in; the old owner's others stay, not the owner", async () => {
		const first = await userOwnerApp(ada, { plugins: { whoami: { "server.ts": WHOAMI } } });
		const old = (await readFile(first.app.ownerTokenFile, "utf8")).trim();
		const other = await bearerFor(first.app, ada);
		await first.app.close(context);
		const second = await userOwnerApp(bob, { dataDir: first.dataDir, root: first.root });
		const replaced = (await readFile(second.app.ownerTokenFile, "utf8")).trim();
		expect(replaced).not.toBe(old);
		expect((await stat(second.app.ownerTokenFile)).mode & 0o777).toBe(0o600);
		const owner = { authorization: `Bearer ${replaced}` };
		expect(await whoami(second.port, owner)).toEqual(bob);
		expect((await send(second.port, "GET", "/whoami", { headers: { authorization: `Bearer ${old}` } })).status).toBe(
			401,
		);
		expect(await whoami(second.port, other)).toEqual(ada);
		// An owner-only route: the old owner's sign-in is refused, the new owner's accepted.
		const { code } = JSON.parse((await send(second.port, "POST", "/_chord/pair")).body.toString()) as {
			code: string;
		};
		expect((await send(second.port, "GET", `/_chord/pair/${code}`, { headers: other })).status).toBe(403);
		expect((await send(second.port, "GET", `/_chord/pair/${code}`, { headers: owner })).status).toBe(200);
		await second.app.close(context);
	});
});
