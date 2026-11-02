// Tests of the owner's sign-in (slice 13 §2): the owner link (single use, expiry, replaced at each start, the token
// only in the fragment), and the owner token file (mode 0600, kept while its session lives, replaced once revoked).

import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Sessions } from "../../../src/next-node/app/index.ts";
import { OwnerLink } from "../../../src/next-node/app/owner.ts";
import { send } from "../http/support.ts";
import { testApp, WHOAMI } from "./support.ts";

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
		const listed = await app.host.root(async (ctx) => (await ctx.get(Sessions, {})).list.value, context);
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

	it("is replaced at the next start when its secret no longer matches its session (review L6)", async () => {
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

	it("is replaced at the next start once its session was revoked", async () => {
		const first = await testApp();
		const token = (await readFile(first.app.ownerTokenFile, "utf8")).trim();
		await first.app.host.root(async (ctx) => {
			const sessions = await ctx.get(Sessions, {});
			const id = token.slice(0, token.indexOf("."));
			await sessions.revoke(id, ctx);
		}, context);
		await first.app.close(context);
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		const replaced = (await readFile(second.app.ownerTokenFile, "utf8")).trim();
		expect(replaced).not.toBe(token);
		expect((await stat(second.app.ownerTokenFile)).mode & 0o777).toBe(0o600);
		await second.app.close(context);
	});
});
