// Tests of the users plugin (slice 13 §3): the app makes it with its profile schema, re-exports it through its API and
// adds it to its root as a one-line plugin; other plugins and the server reach `Users`; profiles persist.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { obj, opt, str } from "../../../src/contracts/index.ts";
import { defineUsers } from "../../../src/node/app/index.ts";
import { Http } from "../../../src/node/http/index.ts";
import { rejection } from "../../support.ts";
import { API, testApp } from "./support.ts";

const users = defineUsers(obj({ name: str(), title: opt(str()) }));

/** The tests' API with the users plugin in its server module. */
const WITH_USERS = { ...API, modules: { ...API.modules, "@test/app/v1/server": { Http, users } } };

/** The app's one-line plugin adding it. */
const PLUGIN = { "server.ts": 'import { users } from "@test/app/v1/server";\nexport default users.facet;' };

describe("users", () => {
	it("keeps accounts by id with the app's profile, listed, updated, removed, and kept across starts", async () => {
		const first = await testApp({ api: WITH_USERS, plugins: { users: PLUGIN } });
		const ref = await first.app.host.get(users.Users, {}, context);
		await ref.update({ id: "u1", profile: { name: "Ada" } }, context);
		await ref.update({ id: "u2", profile: { name: "Grace", title: "Admiral" } }, context);
		await ref.update({ id: "u1", profile: { name: "Ada L." } }, context);
		expect(await ref.get("u1", context)).toEqual({ name: "Ada L." });
		expect(await ref.get("nobody", context)).toBeNull();
		await ref.remove("u2", context);
		expect(ref.list.value).toEqual([{ id: "u1", profile: { name: "Ada L." } }]);
		expect(await rejection(ref.update({ id: "u3", profile: { title: "no name" } as never }, context))).toMatchObject({
			code: "invalid",
		});
		ref.release();
		await first.app.close(context);
		const second = await testApp({ api: WITH_USERS, dataDir: first.dataDir, root: first.root });
		const again = await second.app.host.get(users.Users, {}, context);
		expect(again.list.value).toEqual([{ id: "u1", profile: { name: "Ada L." } }]);
		again.release();
		await second.app.close(context);
	});
});
