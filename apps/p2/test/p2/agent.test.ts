// Code mode's one-shot `agent` tool (fake provider): parallel agents, validated JSON answers with retries, no reports
// to the main conversation, listing by nested call ID, and read-only inspection.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { createAgentExtension } from "../../plugins/agent/tool.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SubagentControl, Subagents } from "../../plugins/subagents/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { expectChord, type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const SCRIPT = `
const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
const results = await Promise.all([1, 2].map((n) => tools.agent({ prompt: 'json {"n":' + n + '}', schema, tools: [] })));
let error = "";
try {
	await tools.agent({ prompt: 'json {"n":"x"}', schema, tools: [] });
} catch (caught) {
	error = caught.message;
}
return { results, error };
`;

const messages = (view: ConversationView | null | undefined) =>
	(view?.entries ?? []).flatMap((entry) => entry.model ?? []);
const codemodeResult = (view: ConversationView | null | undefined) =>
	messages(view).find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
	);
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;

/** A code mode result's text after its "Script completed" header (Durable's coding-agent layout). */
const scriptOutput = (text: string): string => {
	const match = /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/.exec(text);
	assert.ok(match, `a completed script's result: ${text}`);
	return text.slice(match[0].length);
};

/** How the agent tool describes itself (Pi Mobile's words): code mode's section lists it, there is no section of its own. */
const AGENT_DESCRIPTION =
	"Run a one-shot subagent in your cwd and resolve to its final answer, parsed as JSON and validated against `schema` (a JSON Schema object). Rejects when the subagent fails, or when its answer still does not validate after 3 attempts. Its answer is not reported to you, only what the script returns. Run many at once with `Promise.all`.";

describe("code mode agent prompt", () => {
	it("describes the tool itself, for code mode's listing, without a prompt section of its own", () => {
		const extension = createAgentExtension({} as Models, () => new Map());
		assert.equal(extension.sections, undefined);
		const [tool] = extension.tools ?? [];
		assert.equal(tool?.description, AGENT_DESCRIPTION);
		assert.deepEqual(tool?.callers, ["tools"]);
		const parameters = tool?.parameters as { properties: Record<string, { description?: string }> };
		assert.equal(
			parameters.properties.thinkingLevel?.description,
			"off|minimal|low|medium|high|xhigh|max; default: the caller's.",
		);
		assert.equal(parameters.properties.model?.description, "'provider/modelId'; default: the caller's.");
	});
});

describe("code mode agent (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let callId: string;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	});
	after(async () => {
		await fixture?.close();
	});

	it("runs parallel one-shot agents with validated JSON, retries, and no reports", async () => {
		await chat.send({ text: `codemode ${SCRIPT}`, requestId: "script" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => codemodeResult(value) !== undefined && !live(value)?.run, 40_000);
		const result = codemodeResult(view)!;
		callId = result.toolCallId;
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.equal(result.isError, false, text);
		const value = JSON.parse(scriptOutput(text)) as { results: unknown; error: string };
		assert.deepEqual(value.results, [{ n: 1 }, { n: 2 }]);
		// The first answer is JSON of the wrong shape, the retries' answers are not JSON at all.
		assert.match(value.error, /not usable after 3 attempts: it is not JSON/);
		assert.ok(
			!messages(view).some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes('kind=\\"subagent\\"'),
			),
			"answers are not reported to the main conversation",
		);
	});

	it("lists each one-shot agent by its nested call ID and keeps it read-only", async () => {
		const list = await holdIn(owner, Subagents, {}, "reader");
		const children = await until(list.children, (value) => value?.[session]?.length === 3);
		const agents = children![session]!;
		assert.deepEqual(
			agents.map((agent) => [agent.kind, agent.name, agent.callId?.startsWith(`${callId}/c`)]).sort(),
			[
				["agent", 'json {"n":"x"}', true],
				["agent", 'json {"n":1}', true],
				["agent", 'json {"n":2}', true],
			],
		);
		assert.ok(agents.every((agent) => agent.lastEntryId === 0 && agent.tools.length === 0));
		const first = agents.find((agent) => agent.name === 'json {"n":1}')!;
		// Read-only: it can be opened and read, not prompted, reconfigured or archived.
		const sub = await holdIn(owner, Chat, { session, conversation: first.conversationId }, "participant");
		await until(sub.view, (value) => JSON.stringify(value?.entries ?? []).includes('{\\"n\\":1}'));
		assert.equal(sub.variant, "participant");
		const refused = await expectChord(
			sub.send({ text: "hello", requestId: "steer" }, BACKGROUND_CONTEXT),
			"forbidden",
		);
		assert.match(refused.message, /read-only/);
		await expectChord(sub.configure({ thinkingLevel: "off" }, BACKGROUND_CONTEXT), "forbidden");
		await expectChord(sub.dequeue({ submissionId: 1 }, BACKGROUND_CONTEXT), "forbidden");
		const control = owner.hold(SubagentControl, { session }, BACKGROUND_CONTEXT);
		const archive = await expectChord(
			control.archive({ conversation: first.conversationId, archived: true }, BACKGROUND_CONTEXT),
			"forbidden",
		);
		assert.match(archive.message, /read-only/);
		// Stop stays allowed (nothing runs).
		assert.deepEqual(await sub.stop(BACKGROUND_CONTEXT), { restored: [] });
		sub.release();
		control.release();
		list.release();
	});
});

/** The prompt sections in effect at the end of a conversation's view: its system messages replayed in order. */
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

describe("code mode off while the agent plugin stays", () => {
	it("keeps the agent tool installed, out of the prompt without code mode, and listed again with it", async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		t.after(follow(chat.view, () => {}));
		const answered = (text: string) =>
			until(chat.view, (value) => JSON.stringify(value).includes(`Echo: ${text}`) && !live(value)?.run);
		await chat.send({ text: "with code mode", requestId: "a" }, BACKGROUND_CONTEXT);
		const listed = sections(await answered("with code mode"));
		assert.ok(listed.codemode?.includes(AGENT_DESCRIPTION), "code mode lists the agent tool with its description");
		assert.equal(listed.agent, undefined, "no section of its own");

		// Code mode off (its setting turns the extension off live); the agent plugin stays. The worker's settings
		// observer is asynchronous: turns go until one runs without the listing.
		await writeFile(join(fixture.dataDir, "settings.json"), JSON.stringify({ codemode: false }));
		const turn = async (prefix: string, done: (listed: Record<string, string>) => boolean) => {
			for (let attempt = 0; attempt < 20; attempt++) {
				const text = `${prefix} ${attempt}`;
				await chat.send({ text, requestId: text }, BACKGROUND_CONTEXT);
				if (done(sections(await answered(text)))) return;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			assert.fail(`the worker never applied the settings change (${prefix})`);
		};
		await turn("without code mode", (listed) => listed.codemode === undefined);

		// The agent extension stayed installed: with code mode back, it is listed again and scripts can call it.
		await writeFile(join(fixture.dataDir, "settings.json"), JSON.stringify({}));
		await turn("with code mode again", (listed) => listed.codemode !== undefined);
		await chat.send(
			{
				text: 'codemode return await tools.agent({ prompt: \'json {"back":true}\', schema: { type: "object" } });',
				requestId: "c",
			},
			BACKGROUND_CONTEXT,
		);
		const view = await until(chat.view, (value) => codemodeResult(value) !== undefined && !live(value)?.run, 40_000);
		assert.equal(codemodeResult(view)?.isError, false);
		assert.deepEqual(
			JSON.parse(
				scriptOutput(
					String(
						codemodeResult(view)
							?.content.map((part) => (part.type === "text" ? part.text : ""))
							.join(""),
					),
				),
			),
			{ back: true },
		);
		assert.ok(sections(view).codemode?.includes(AGENT_DESCRIPTION));
	});
});
