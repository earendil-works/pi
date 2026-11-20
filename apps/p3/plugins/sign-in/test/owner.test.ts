// The owner's sign-in (`owner.ts`): the owner link, made fresh by the command `owner-link` (as `p3` asks it over the
// data directory's socket) or a signed-in owner's post; single use, 10 minutes, the previous one dropped; its page
// reads the fragment; its post refuses anything but the current token, malformed bodies included. The plugin tier for
// what needs no listener, the real server (`test/support.ts`) for the rest.

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, defineFacet, type P3Principal } from "@earendil-works/p3/v1";
import { type ServerRuntime as Runtime, ServerCommands, ServerRuntime } from "@earendil-works/p3/v1/server";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { ownerCookie, type TestServer, testServer } from "../../../test/support.ts";
import { SignIns } from "../contract.ts";

const OWNER: P3Principal = { kind: "owner" };
const MAX: P3Principal = { kind: "person", id: "max", name: "Max" };

/** The servers a case started, closed after it. */
const servers: TestServer[] = [];

afterEach(async () => {
	mock.timers.reset();
	for (const server of servers.splice(0)) await server.close();
});

/** A test server, closed after the case. */
async function started(): Promise<TestServer> {
	const t = await testServer();
	servers.push(t);
	return t;
}

/** A device sign-in of `principal` on `t`: its bearer header. */
async function bearer(t: TestServer, principal: P3Principal): Promise<Record<string, string>> {
	const issued = await t.server.runtime.host.root(
		async (ctx) => (await ctx.get(SignIns, {})).issue({ principal, label: "test", kind: "device" }, ctx),
		context,
	);
	return { authorization: `Bearer ${issued.token}` };
}

/** A fresh owner link from `t`'s command `owner-link`, as `p3` asks it over the data directory's socket. */
async function commandLink(t: TestServer): Promise<string> {
	const commands = (await t.server.runtime.host.registry(ServerCommands, context)).value;
	return (await commands.get("owner-link")!.run(context)) as string;
}

/** Posts `body` to the owner link's route as its page does. */
function post(t: TestServer, body: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${t.server.port}/_p3/owner`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

/** Posts a link's token. */
function postToken(t: TestServer, link: string): Promise<Response> {
	return post(t, JSON.stringify({ token: new URL(link).hash.slice(1) }));
}

/** The answer of `POST /_p3/owner/link` to `headers`. */
function askLink(t: TestServer, headers: Readonly<Record<string, string>>): Promise<Response> {
	return fetch(`http://127.0.0.1:${t.server.port}/_p3/owner/link`, { method: "POST", headers });
}

describe("the owner link", () => {
	it("is made by the command at the server's origin; its page reads the fragment; it signs a browser in once", async () => {
		const t = await started();
		const link = new URL(await commandLink(t));
		assert.deepEqual([link.origin, link.pathname], [`http://127.0.0.1:${t.server.port}`, "/_p3/owner"]);
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
		assert.equal((await askLink(t, { cookie })).status, 200, "the browser is the owner's");
		const browsers = await t.server.runtime.host.root(
			async (ctx) => (await ctx.get(SignIns, {})).list.value.filter(({ kind }) => kind === "browser"),
			context,
		);
		assert.deepEqual(
			browsers.map(({ label, principal }) => [label, principal]),
			[["owner browser", OWNER]],
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

	it("is made fresh by `POST /_p3/owner/link` only for the owner, and drops the command's", async () => {
		const t = await started();
		assert.equal((await askLink(t, {})).status, 401);
		assert.equal((await askLink(t, await bearer(t, MAX))).status, 403);
		const dropped = await commandLink(t);
		const answered = await askLink(t, await bearer(t, OWNER));
		assert.equal(answered.status, 200);
		const { link } = (await answered.json()) as { readonly link: string };
		assert.equal(new URL(link).origin, `http://127.0.0.1:${t.server.port}`);
		assert.equal((await postToken(t, dropped)).status, 403);
		assert.equal((await postToken(t, link)).status, 200);
	});

	it("signs `p3`'s browser in over the data directory's socket, and that cookie asks for the next link", async () => {
		const t = await started();
		const cookie = await ownerCookie(t.dataDir, t.server.port);
		const answered = await askLink(t, { cookie });
		assert.equal(answered.status, 200);
		const { link } = (await answered.json()) as { readonly link: string };
		assert.equal((await postToken(t, link)).status, 200);
	});

	it("is refused by the command before the server listens", async () => {
		// The owner's routes and command read only `listening` of the runtime.
		const runtime = { listening: () => undefined } as unknown as Runtime;
		const stub = defineFacet((host) => host.serve(ServerRuntime, { compose: () => runtime }));
		const t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{ kind: "server", stubs: [{ name: "p3.server-runtime-stub", facet: stub }] },
			context,
		);
		try {
			const [command] = t.contributions(ServerCommands);
			assert.equal(command!.value.name, "owner-link");
			await assert.rejects(command!.value.run(context), /does not listen/);
		} finally {
			await t.close(context);
		}
	});
});
