// Tests of the ephemeral login plugin (slice 13 §3): a public route taking a name signs the browser in as a fresh
// `{ kind: "user", id, name }` with a cookie that ends with the browser, and the session ends with the server.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { ephemeralLoginFacet } from "../../../src/next-node/app/index.ts";
import { Http } from "../../../src/next-node/http/index.ts";
import { send } from "../http/support.ts";
import { API, type TestPrincipal, testApp, WHOAMI } from "./support.ts";

const login = ephemeralLoginFacet<TestPrincipal>();

/** The tests' API with the ephemeral login plugin in its server module. */
const WITH_LOGIN = { ...API, modules: { ...API.modules, "@test/app/v1/server": { Http, login } } };

const PLUGINS = {
	login: { "server.ts": 'import { login } from "@test/app/v1/server";\nexport default login;' },
	whoami: { "server.ts": WHOAMI },
};

/** Logs in as `name`. */
function logIn(port: number, name: unknown) {
	return send(port, "POST", "/_chord/login", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
}

describe("ephemeral login", () => {
	it("signs in under a picked name as a fresh user, each login its own", async () => {
		const { app, port } = await testApp({ api: WITH_LOGIN, plugins: PLUGINS });
		const first = await logIn(port, "  ada  ");
		const second = await logIn(port, "ada");
		const principal = JSON.parse(first.body.toString()) as { kind: string; id: string; name: string };
		expect(principal).toEqual({ kind: "user", id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: "ada" });
		expect(JSON.parse(second.body.toString()).id).not.toBe(principal.id);
		const set = String(first.headers["set-cookie"]);
		expect(set).not.toContain("Max-Age");
		const whoami = await send(port, "GET", "/whoami", { headers: { cookie: set.split(";")[0]! } });
		expect(JSON.parse(whoami.body.toString())).toEqual(principal);
		expect((await logIn(port, "   ")).status).toBe(400);
		expect((await logIn(port, 7)).status).toBe(400);
		expect(JSON.parse((await logIn(port, "n".repeat(100))).body.toString()).name).toHaveLength(40);
		await app.close(context);
	});

	it("ends its sessions with the server", async () => {
		const first = await testApp({ api: WITH_LOGIN, plugins: PLUGINS });
		const set = String((await logIn(first.port, "ada")).headers["set-cookie"]);
		await first.app.close(context);
		const second = await testApp({ api: WITH_LOGIN, dataDir: first.dataDir, root: first.root });
		expect((await send(second.port, "GET", "/whoami", { headers: { cookie: set.split(";")[0]! } })).status).toBe(401);
		await second.app.close(context);
	});
});
