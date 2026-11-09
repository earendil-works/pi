// Chat mode across a compatible reload of its plugin: the switch and the agent's name stay (they live in a Durable
// document), the held reference stays live, and the reloaded code serves it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ChatMode } from "../../plugins/chat-mode/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

const PLUGINS = [
	"chat",
	"chat-mode",
	"conversations",
	"devices",
	"drafts",
	"envs",
	"files",
	"models",
	"search",
	"sessions",
	"status",
	"subagents",
];

describe("chat-mode reload", () => {
	it("keeps the mode and its name across a compatible reload of the plugin", async (t) => {
		const fixture = await startFixture({ plugins: PLUGINS });
		t.after(() => fixture.close());
		const browser = fixture.browser();
		const session = await (await holdIn(browser, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const mode = await holdIn(browser, ChatMode, { session: session.id, conversation: 1 }, "owner");
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await mode.rename({ name: "Claude" }, BACKGROUND_CONTEXT);
		await until(mode.name, (name) => name === "Claude");
		const result = await fixture.server.reload(["chat-mode"]);
		assert.equal(result.stopped, undefined);
		assert.ok(
			result.steps.some((step) => step.hosts.length > 0),
			"the rollout reached the server and the worker",
		);
		// The same reference follows the reloaded object: the state is the document's, and it still takes changes.
		assert.equal(await until(mode.enabled, (enabled) => enabled), true);
		assert.equal(mode.name.value, "Claude");
		await mode.set({ enabled: false }, BACKGROUND_CONTEXT);
		assert.equal(await until(mode.enabled, (enabled) => !enabled), false);
	});
});
