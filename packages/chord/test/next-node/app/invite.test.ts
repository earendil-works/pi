// Tests of the invite plugin (slice 13 §3): the owner makes an invite for a principal, the invitee's page posts the
// token from the fragment and gets a browser session for it, once; only the owner makes invites.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { inviteFacet, Sessions } from "../../../src/next-node/app/index.ts";
import { Http } from "../../../src/next-node/http/index.ts";
import { send } from "../http/support.ts";
import { API, testApp, WHOAMI } from "./support.ts";

const invite = inviteFacet();

/** The tests' API with the invite plugin and a whoami route in its server module. */
const WITH_INVITE = { ...API, modules: { ...API.modules, "@test/app/v1/server": { Http, invite } } };

const PLUGINS = {
	invite: { "server.ts": 'import { invite } from "@test/app/v1/server";\nexport default invite;' },
	whoami: { "server.ts": WHOAMI },
};

/** A JSON post to `path` with `headers`. */
function post(port: number, path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) {
	return send(port, "POST", path, {
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("invites", () => {
	it("signs the invitee in as the chosen principal once; only the owner invites", async () => {
		const { app, port } = await testApp({ api: WITH_INVITE, plugins: PLUGINS });
		const token = async (principal: unknown) =>
			app.host.root(
				async (ctx) =>
					(await (await ctx.get(Sessions, {})).issue({ principal, label: "t", kind: "device" }, ctx)).token,
				context,
			);
		const owner = { authorization: `Bearer ${await token({ kind: "owner" })}` };
		const user = { authorization: `Bearer ${await token({ kind: "user", id: "u", name: "u" })}` };
		const guest = { kind: "user", id: "g1", name: "Guest" };
		expect((await post(port, "/_chord/invites", { principal: guest, label: "guest" })).status).toBe(401);
		expect((await post(port, "/_chord/invites", { principal: guest, label: "guest" }, user)).status).toBe(403);
		expect((await post(port, "/_chord/invites", { principal: "x", label: "guest" }, owner)).status).toBe(400);
		const made = await post(port, "/_chord/invites", { principal: guest, label: "guest" }, owner);
		const { path } = JSON.parse(made.body.toString()) as { path: string };
		const [page, secret] = path.split("#") as [string, string];
		expect((await send(port, "GET", page)).body.toString()).toContain("location.hash");
		const used = await post(port, page, { token: secret });
		expect(used.status).toBe(200);
		const cookie = String(used.headers["set-cookie"]).split(";")[0]!;
		expect(JSON.parse((await send(port, "GET", "/whoami", { headers: { cookie } })).body.toString())).toEqual(guest);
		expect((await post(port, page, { token: secret })).status).toBe(403);
		await app.close(context);
	});
});
