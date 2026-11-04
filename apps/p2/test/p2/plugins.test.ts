// Plugins are directories with facet files; fixtures load exactly the plugins they name.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Terminals } from "../../plugins/terminals/contract.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import { listPlugins, selectPlugins } from "../../src/hosts/plugins.ts";
import { failureOf, holdIn, settled, startFixture, until } from "./helpers.ts";

/** What a chat session needs; a fixture names every plugin it loads. */
const CHAT = [
	"chat",
	"conversations",
	"drafts",
	"envs",
	"files",
	"models",
	"search",
	"sessions",
	"status",
	"subagents",
];

describe("plugin listing and selection", () => {
	it("lists directories with facet files alphabetically and selects exactly the named plugins", (t) => {
		const root = mkdtempSync(join(tmpdir(), "p2-plugin-list-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		for (const [path, content] of [
			["beta/server.ts", "export default {};"],
			["alpha/worker.ts", "import '../beta/contract.ts';"],
			["alpha/web.tsx", "export default {};"],
			["alpha/helper.ts", ""],
			["notes/README.md", ""],
			["loose.ts", ""],
		] as const) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		const listing = listPlugins(root);
		assert.deepEqual([...listing.keys()], ["alpha", "beta"]);
		assert.deepEqual(listing.get("alpha"), {
			worker: join(root, "alpha/worker.ts"),
			web: join(root, "alpha/web.tsx"),
		});
		assert.deepEqual(selectPlugins(listing), ["alpha", "beta"]);
		assert.deepEqual(selectPlugins(listing, []), []);
		// No dependency is derived from imports: alpha alone is alpha alone.
		assert.deepEqual(selectPlugins(listing, ["beta", "alpha", "beta"]), ["alpha", "beta"]);
		assert.deepEqual(selectPlugins(listing, ["alpha"]), ["alpha"]);
		assert.throws(() => selectPlugins(listing, ["missing"]), /Unknown p2 plugin: missing/);
		for (const name of ["chat", "login", "web-shell"]) assert(selectPlugins(listPlugins()).includes(name), name);
	});

	it("starts exactly login and models and refuses an unloaded plugin's reload", async (t) => {
		const fixture = await startFixture({ plugins: ["models", "login"] });
		t.after(() => fixture.close());
		assert.deepEqual(fixture.server.plugins, ["login", "models"]);
		const login = fixture.browser().hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		await whenLive(login);
		assert.deepEqual(await settled(login.providers), []);
		assert.equal(await settled(login.login), null);
		await assert.rejects(
			login.start({ providerId: "faux", authType: "api_key" }, BACKGROUND_CONTEXT),
			/Provider does not support this login method/,
		);
		const models = fixture.browser().hold(Models, {}, BACKGROUND_CONTEXT);
		const choice = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
		await models.setDefault(choice, BACKGROUND_CONTEXT);
		assert.deepEqual(await until(models.defaultModel, (value) => value?.thinkingLevel === "off"), choice);
		const unavailable = fixture
			.browser()
			.hold(Terminals, { session: "not-opened", view: crypto.randomUUID() }, BACKGROUND_CONTEXT);
		const error = await failureOf(unavailable);
		assert.equal(error.code, "unavailable");
		const files = await readdir(fixture.dataDir);
		assert(!files.some((name) => ["shares.sqlite", "terminals.log", "downloads", "artifacts"].includes(name)));
		await assert.rejects(fixture.server.reload(["terminals"]), /Cannot reload unloaded p2 plugin: terminals/);
	});

	it("starts only a chat subset in the worker and streams with the fake provider", async (t) => {
		const fixture = await startFixture({ plugins: CHAT });
		t.after(() => fixture.close());
		const browser = fixture.browser();
		const session = await (await holdIn(browser, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Subset",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "subset", requestId: "subset" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) =>
			Boolean(
				value?.entries.some(
					(entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("Echo: subset"),
				),
			),
		);
		// Unnamed plugins' worker facets are absent.
		const workspace = browser.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		assert.equal((await failureOf(workspace)).code, "unavailable");
		await fixture.server.reload(["chat"]);
		await chat.send({ text: "after subset reload", requestId: "reload" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) =>
			Boolean(
				value?.entries.some(
					(entry) =>
						entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("Echo: after subset reload"),
				),
			),
		);
	});
});
