// `reload_plugins` (plugins/dev-tools/tool.ts): an ordinary tool (no requirements: whoever's turn, any conversation, a
// subagent's too), reporting per plugin what the server's reload did. The real reload through the server is tested in
// agent-plugins.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createReloadExtension } from "../../plugins/dev-tools/tool.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { guardTool } from "../../src/runtime/tool-access.ts";

const context = durableContext(new AbortController().signal);
const api = {} as ToolExecutionApi;
const text = (result: { output?: readonly { type: string; text?: string }[] }) =>
	(result.output ?? []).map((part) => part.text ?? "").join("");

test("reload_plugins has no requirements and passes the named plugins on", async () => {
	const asked: (readonly string[] | undefined)[] = [];
	const extension = createReloadExtension(
		async (plugins) => {
			asked.push(plugins);
			return { plugins: [{ plugin: "chat", outcome: "applied" }], logs: [] };
		},
		() => false,
	);
	const tool = extension.tools![0]!;
	assert.equal(tool.name, "reload_plugins");
	assert.equal(tool.replay, "unsafe");
	assert.equal(guardTool(tool), tool, "no scope, no lock rule: unguarded");
	const result = await tool.execute({ plugins: ["chat"] }, api, context);
	assert.equal(result.isError, false);
	assert.equal(text(result), "chat: applied");
	await tool.execute({}, api, context);
	assert.deepEqual(asked, [["chat"], undefined]);
});

test("reload_plugins reports failures, refusals and logged errors as an error result", async () => {
	const extension = createReloadExtension(
		async () => ({
			plugins: [
				{ plugin: "counter", outcome: "failed", errors: ['server: counter/server.ts:3:13: Unexpected ";"'] },
				{ plugin: "broken", outcome: "refused", errors: ["package.json: invalid JSON"] },
			],
			logs: ["server: something failed"],
		}),
		() => false,
	);
	const result = await extension.tools![0]!.execute({}, api, context);
	assert.equal(result.isError, true);
	assert.equal(
		text(result),
		[
			"counter: failed",
			'  server: counter/server.ts:3:13: Unexpected ";"',
			"broken: refused",
			"  package.json: invalid JSON",
			"Errors logged since:",
			"  server: something failed",
		].join("\n"),
	);
	const busy = createReloadExtension(
		async () => ({ refused: "Another plugin reload is running", plugins: [], logs: [] }),
		() => false,
	);
	const refused = await busy.tools![0]!.execute({}, api, context);
	assert.equal(refused.isError, true);
	assert.equal(text(refused), "Nothing reloaded: Another plugin reload is running");
});
