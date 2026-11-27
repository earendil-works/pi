// The owner's sign-in (`owner.ts`): the owner link, made fresh by the command `owner-link` (as `p3` asks it over the
// data directory's socket); single use, 10 minutes, the previous one dropped; its page reads the fragment; its post
// refuses anything but the current token, malformed bodies included, and signs a browser in as the owner. The plugin
// tier for what needs no listener, the real server (`testServer`) for the rest; the probe's route
// (`GET /_probe/principal`) says what a cookie signs in as.

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { ServerCommands, ThingsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { SignIns } from "../contract.ts";

/** The tests' probe plugin, whose route says what a request signed in as. */
const PROBE = fileURLToPath(new URL("../../../test/plugins/probe/", import.meta.url));

/** The servers a case started, closed after it. */
const servers: TestServer[] = [];

afterEach(async () => {
	mock.timers.reset();
	for (const server of servers.splice(0)) await server.close(context);
});

/** A test server with the probe, closed after the case. */
async function started(): Promise<TestServer> {
	const t = await testServer({ plugins: [PROBE] }, context);
	servers.push(t);
	return t;
}

/** A fresh owner link from `t`'s command `owner-link`, as `p3` asks it over the data directory's socket. */
async function commandLink(t: TestServer): Promise<string> {
	const commands = (await t.host.registry(ServerCommands, context)).value;
	return (await commands.get("owner-link")!.run(context)) as string;
}

/** The owner's person on `t` (made at its first start), as a principal. */
async function ownerOf(t: TestServer): Promise<P3Principal> {
	const [found] = (
		await t.host.root(async (ctx) => (await ctx.get(ThingsStore, {})).persons.owners.page({}, 1, ctx), context)
	).items;
	return { kind: "person", id: found!.person, name: found!.name };
}

/** Posts `body` to the owner link's route as its page does. */
function post(t: TestServer, body: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${t.port}/_p3/owner`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

/** Posts a link's token. */
function postToken(t: TestServer, link: string): Promise<Response> {
	return post(t, JSON.stringify({ token: new URL(link).hash.slice(1) }));
}

/** The principal a browser with `cookie` signs in as on `t`, or `undefined`. */
async function principalOf(t: TestServer, cookie: string): Promise<P3Principal | undefined> {
	const answer = await fetch(`http://127.0.0.1:${t.port}/_probe/principal`, { headers: { cookie } });
	return answer.status === 401 ? undefined : ((await answer.json()) as P3Principal);
}

describe("the owner link", () => {
	it("is made by the command at the server's origin; its page reads the fragment; it signs a browser in once", async () => {
		const t = await started();
		const link = new URL(await commandLink(t));
		assert.deepEqual([link.origin, link.pathname], [`http://127.0.0.1:${t.port}`, "/_p3/owner"]);
		assert.match(link.hash, /^#[A-Za-z0-9_-]{43}$/);
		const page = await fetch(`${link.origin}${link.pathname}`);
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.ok(html.includes("location.hash") && html.includes("<script nonce="), html);
		const signed = await postToken(t, link.href);
		assert.equal(signed.status, 200);
		assert.equal((await postToken(t, link.href)).status, 403, "used up");
		// Asked after the check above: a fresh link would replace the used one anyway.
		const cookie = signed.headers.get("set-cookie")!.split(";")[0]!;
		const owner = await ownerOf(t);
		assert.deepEqual(await principalOf(t, cookie), owner, "the browser is the owner's person's");
		const browsers = await t.host.root(
			async (ctx) => (await ctx.get(SignIns, {})).list.value.filter(({ kind }) => kind === "browser"),
			context,
		);
		assert.deepEqual(
			browsers.map(({ label, principal }) => [label, principal]),
			[["owner browser", owner]],
		);
	});

	it("is valid 10 minutes, and a fresh one drops the previous", async () => {
		const t = await started();
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start });
		const expiring = await commandLink(t);
		mock.timers.setTime(start + 10 * 60_000);
		assert.equal((await postToken(t, expiring)).status, 403);
		const previous = await commandLink(t);
		const current = await commandLink(t);
		assert.equal((await postToken(t, previous)).status, 403);
		mock.timers.setTime(start + 20 * 60_000 - 1);
		assert.equal((await postToken(t, current)).status, 200);
	});

	it("refuses a wrong token, and a body that is no JSON or carries no token, reporting nothing", async () => {
		const t = await started();
		const link = await commandLink(t);
		const token = new URL(link).hash.slice(1);
		const bodies = [
			JSON.stringify({ token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}` }),
			JSON.stringify({ token: "" }),
			JSON.stringify({ token: 1 }),
			JSON.stringify({}),
			"null",
			"[]",
			JSON.stringify(token),
		];
		for (const body of bodies) assert.equal((await post(t, body)).status, 403, body);
		for (const body of ["", "not json", "{"]) assert.equal((await post(t, body)).status, 400, body);
		// None used the link up.
		assert.equal((await postToken(t, link)).status, 200);
		assert.deepEqual(t.errors, []);
	});

	it("signs `p3`'s browser in as the owner over the data directory's socket", async () => {
		const t = await started();
		assert.deepEqual(await principalOf(t, await t.cookie(context)), await ownerOf(t));
	});

	it("is refused by the command before the server listens", async () => {
		// The plugin tier's server does not listen.
		const t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server" }, context);
		try {
			const command = (await t.host.registry(ServerCommands, context)).value.get("owner-link");
			await assert.rejects(command!.run(context), /does not listen/);
		} finally {
			await t.close(context);
		}
	});
});
