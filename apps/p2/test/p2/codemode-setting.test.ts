// The `codemode` setting (Pi Mobile's, default on in p2): `false` in settings.json uninstalls code mode live from a
// running worker, the codemode plugin staying loaded and the agent tool installed; `true` (or nothing) offers it again.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { expectVariant } from "../../src/runtime/chord.ts";
import { validateSettings } from "../../src/runtime/settings.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const codemodeResults = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		),
	);
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** The prompt sections in effect at the end of a conversation: its system messages replayed in order. */
function sections(view: ConversationView | null | undefined): Record<string, string> {
	const current: Record<string, string> = {};
	for (const entry of view?.entries ?? [])
		for (const message of entry.model ?? []) {
			if (message.role !== "system") continue;
			for (const [key, value] of Object.entries(message.sections ?? {})) {
				if (value === null) delete current[key];
				else current[key] = value;
			}
		}
	return current;
}

test("Pi Mobile's settings.json with `codemode` validates", () => {
	assert.deepEqual(validateSettings({ codemode: false }), { codemode: false });
	assert.throws(() => validateSettings({ codemode: "yes" }), /Invalid settings/);
});

test(
	"the codemode setting installs and uninstalls code mode live; the agent tool stays",
	{ timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const chat = expectVariant(
			await owner.get(Chat, { session, conversation: 1 }, BACKGROUND_CONTEXT),
			"participant",
		);
		let sent = 0;
		/** Sends `message` and waits for the run it starts to end. */
		const exchange = async (message: string): Promise<ConversationView> => {
			const before = chat.view.value?.entries.length ?? 0;
			await chat.send({ text: message, requestId: `m${++sent}` }, BACKGROUND_CONTEXT);
			const view = await until(
				chat.view,
				(value) => (value?.entries.length ?? 0) > before + 1 && !live(value)?.run,
				30_000,
			);
			return view!;
		};
		/** Sends until the worker applied the settings file (its observer is asynchronous): `ready(view)` holds. */
		const settle = async (ready: (view: ConversationView) => boolean) => {
			for (let attempt = 0; attempt < 20; attempt++) {
				const view = await exchange(`probe ${attempt}`);
				if (ready(view)) return view;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			throw new Error("the worker never applied the settings change");
		};

		// Default on: scripts run; code mode's section lists the tools scripts call, the agent tool among them.
		let view = await exchange("codemode");
		assert.match(text(codemodeResults(view).at(-1)), /^Script completed/);
		assert.ok(sections(view).codemode?.includes("Run a one-shot subagent in your cwd"));
		assert.equal(sections(view).agent, undefined);

		// Off: no tool, no listing; the plugin stays loaded and the agent tool installed (only scripts can call it).
		await writeFile(join(fixture.dataDir, "settings.json"), JSON.stringify({ codemode: false }));
		view = await settle((value) => sections(value).codemode === undefined);
		assert.ok(fixture.server.plugins.includes("codemode"));
		view = await exchange("codemode");
		const refused = codemodeResults(view).at(-1);
		assert.equal(refused?.isError, true);
		assert.match(text(refused), /not available/);

		// On again (an absent setting means on): offered and working, the agent tool listed again.
		await writeFile(join(fixture.dataDir, "settings.json"), JSON.stringify({}));
		view = await settle((value) => sections(value).codemode !== undefined);
		assert.ok(sections(view).codemode?.includes("Run a one-shot subagent in your cwd"));
		view = await exchange("codemode");
		assert.match(text(codemodeResults(view).at(-1)), /^Script completed/);
	},
);
