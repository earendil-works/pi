// Subagents message the main agent and each other with the `team` tool, as structural `p2.agent-message` entries;
// their end-of-turn reports are such entries too. The main agent is never offered the tool.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { AGENT_MESSAGE_ENTRY, type AgentMessage, Subagents } from "../../plugins/subagents/contract.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const agentMessages = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.filter((entry: EntryRecord) => entry.kind === AGENT_MESSAGE_ENTRY)
		.map((entry) => ({
			data: entry.data as AgentMessage,
			model: JSON.stringify(entry.model?.[0]?.content ?? ""),
		}));

const toolResults = (view: ConversationView | null | undefined, tool: string) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool);

describe("subagent team messaging (fake provider)", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture();
	});
	after(async () => {
		await fixture?.close();
	});

	it("a subagent asks the main agent, notes a sibling and reads its answer; reports are entries", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		const agents = await holdIn(owner, Subagents, {}, "reader");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = (conversation: number) => holdIn(owner, Chat, { session: session.id, conversation }, "participant");
		const root = await chat(1);
		const keep = follow(root.view, () => {});
		const idle = () => until(status.statuses, (value) => value?.[session.id]?.tasks === 0, 30_000);
		const spawn = async (name: string, message: string) => {
			await root.send(
				{
					text: `subagent ${JSON.stringify({ action: "spawn", name, message, tools: [] })}`,
					requestId: name,
				},
				BACKGROUND_CONTEXT,
			);
			await idle();
		};

		await spawn("first", "hello first");
		const question = { action: "send", to: "parent", message: "Which API should I use?", intent: "question" };
		await spawn("asker", `team ${JSON.stringify(question)}`);
		const view = await until(root.view, (value) => agentMessages(value).some((m) => m.data.intent === "question"));
		const asked = agentMessages(view).find((m) => m.data.intent === "question");
		assert.equal(asked?.data.from.name, "asker");
		assert.equal(asked?.data.text, "Which API should I use?");
		assert.match(asked?.model ?? "", /<sender kind=\\"subagent\\" name=\\"asker\\"\/>/);
		assert.match(asked?.model ?? "", /\[asks; answer with subagent send to asker\] Which API/);
		// The owner started the turn that spawned it: what it writes records that, so the main agent's turn on it may act
		// for the owner.
		assert.equal(asked?.data.origin, "owner");
		// The question started a root turn, and every report is an entry with the subagent's name.
		await until(root.view, (value) =>
			JSON.stringify(value).includes("Echo: [asks; answer with subagent send to asker]"),
		);
		await idle();
		const reports = agentMessages(root.view.value).filter((m) => m.data.intent === "answered");
		assert.deepEqual(reports.map((m) => m.data.from.name).sort(), ["asker", "first"]);
		assert.match(reports[0]?.model ?? "", /\[answered, no reply needed\]/);
		assert.deepEqual(
			reports.map((m) => m.data.origin),
			["owner", "owner"],
		);

		// A note to a sibling arrives in its conversation; reading a sibling's answer.
		const children = await until(agents.children, (value) => (value?.[session.id]?.length ?? 0) === 2);
		const first = children?.[session.id]?.find((child) => child.name === "first");
		const asker = children?.[session.id]?.find((child) => child.name === "asker");
		assert(first && asker);
		const note = { action: "send", to: "first", message: "FYI: done with step 1", intent: "note" };
		await root.send(
			{
				text: `subagent ${JSON.stringify({ action: "send", name: "asker", message: `team ${JSON.stringify(note)}` })}`,
				requestId: "note",
			},
			BACKGROUND_CONTEXT,
		);
		const sibling = await chat(first.conversationId);
		const noted = await until(sibling.view, (value) => agentMessages(value).some((m) => m.data.intent === "note"));
		const received = agentMessages(noted).find((m) => m.data.intent === "note");
		assert.equal(received?.data.from.name, "asker");
		assert.match(received?.model ?? "", /\[notes, no reply needed\] FYI/);
		assert.equal(received?.data.origin, "owner");
		await idle();
		await root.send(
			{
				text: `subagent ${JSON.stringify({ action: "send", name: "asker", message: 'team {"action":"answer","name":"first"}' })}`,
				requestId: "answer",
			},
			BACKGROUND_CONTEXT,
		);
		const askerChat = await chat(asker.conversationId);
		const answered = await until(askerChat.view, (value) => toolResults(value, "team").length >= 3);
		const text = toolResults(answered, "team")
			.at(-1)
			?.content.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		assert.match(text ?? "", /Echo: /, "the sibling's latest answer");
		await idle();

		// The main agent is not offered the tool.
		await root.send({ text: 'team {"action":"list"}', requestId: "root-team" }, BACKGROUND_CONTEXT);
		const refused = await until(root.view, (value) => toolResults(value, "team").length > 0);
		assert.equal(toolResults(refused, "team")[0]?.isError, true);
		keep();
		for (const handle of [root, sibling, askerChat]) handle.release();
	});
});
