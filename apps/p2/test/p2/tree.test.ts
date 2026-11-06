// `/tree` (docs/tree.md) on the real server and session worker with the fake provider: the tree of the main
// conversation and its branches, switching (forking, reusing a branch, before the first message), the session row's
// `main`, read-only earlier branches, main-only tools in a branch, switching while busy, branch labels (stored at the fork,
// renamed, conversation 1's null for the session title) and `p2.main` version 1's migration.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type ConversationView, createSession, defineDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactList } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { SessionTree, type Tree } from "../../plugins/tree/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { MainDoc } from "../../src/runtime/main-conversation.ts";
import { openSessionStorage } from "../../src/runtime/session-store.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** `p2.main` as version 1 stored it: the top-level conversations' IDs, no labels. */
const MainDocV1 = defineDoc<{ conversation: number; branches: number[] }>({
	kind: "p2.main",
	version: 1,
	scope: "session",
	initial: () => ({ conversation: ROOT_CONVERSATION_ID, branches: [ROOT_CONVERSATION_ID] }),
	checkpointWhen: () => true,
});

const text = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
const toolResults = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.filter((message): message is ToolResultMessage => message.role === "toolResult");
const nodeWith = (tree: Tree, role: "user" | "assistant", value: string) => {
	const node = tree.nodes.find((each) => each.role === role && each.text === value);
	assert(node, `no ${role} node ${value}`);
	return node;
};

describe("/tree (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: Session;
	const chatOf = (conversation: number) => holdIn(owner, Chat, { session: session.id, conversation }, "participant");
	const treeRef = () => holdIn(owner, SessionTree, { session: session.id }, "owner");
	const idle = async () => {
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		status.release();
	};
	const sessionsRef = async () => {
		const ref = await holdIn(owner, Sessions, {}, "owner");
		if (ref.variant !== "owner") throw new Error("owner expected");
		return ref;
	};
	/** The session row's branches once `ready` accepts them (newest first). */
	const branchesWhen = async (ready: (branches: Session["branches"]) => boolean) => {
		const rows = await until((await sessionsRef()).sessions, (list) => {
			const row = list.find((each) => each.id === session.id);
			return row !== undefined && ready(row.branches);
		});
		return rows.find((each) => each.id === session.id)!.branches;
	};
	const send = async (conversation: number, value: string) => {
		const chat = await chatOf(conversation);
		await chat.send({ text: value, requestId: `${conversation}:${value}` }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (next) => text(next).includes(`Echo: ${value}`));
		chat.release();
		await idle();
		return view;
	};

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		session = await (await sessionsRef()).create({ cwd: fixture.workspace, title: "Tree" }, BACKGROUND_CONTEXT);
		await send(1, "first");
		await send(1, "second");
	});
	after(async () => {
		await fixture?.close();
	});

	it("lists the main conversation's messages as one line", async () => {
		const tree = await (await treeRef()).tree(BACKGROUND_CONTEXT);
		assert.equal(tree.main, 1);
		assert.deepEqual(
			tree.nodes.map((node) => `${node.role}:${node.text}`),
			["user:first", "assistant:Echo: first", "user:second", "assistant:Echo: second"],
		);
		for (const [index, node] of tree.nodes.entries())
			assert.equal(node.parent, index === 0 ? null : tree.nodes[index - 1]!.entry);
		assert.equal(tree.current, tree.nodes.at(-1)!.entry);
	});

	it("forks before a chosen user message; the earlier branch is read-only", async () => {
		const ref = await treeRef();
		const before = await ref.tree(BACKGROUND_CONTEXT);
		const second = nodeWith(before, "user", "second");
		const switched = await ref.navigate({ entry: second.entry }, BACKGROUND_CONTEXT);
		assert.notEqual(switched.conversation, 1);
		assert.equal(switched.text, "second");
		const sessions = await sessionsRef();
		await until(
			sessions.sessions,
			(rows) => rows.find((row) => row.id === session.id)?.main === switched.conversation,
		);
		// Labelled at once with the message the owner chose to edit (not the answer before it); conversation 1 has none.
		assert.deepEqual(await branchesWhen((branches) => branches.length === 2), [
			{ conversation: switched.conversation, label: "second" },
			{ conversation: 1, label: null },
		]);
		// The branch holds the history before "second" and goes on from there.
		const view = await send(switched.conversation, "other");
		assert.match(text(view), /Echo: first/);
		assert.doesNotMatch(text(view), /Echo: second/);
		// Conversation 1 is an earlier branch now.
		const earlier = await chatOf(1);
		await assert.rejects(
			earlier.send({ text: "no", requestId: "no" }, BACKGROUND_CONTEXT),
			/earlier branch of the session/,
		);
		earlier.release();
		const tree = await ref.tree(BACKGROUND_CONTEXT);
		assert.equal(tree.main, switched.conversation);
		const other = nodeWith(tree, "user", "other");
		assert.equal(other.parent, nodeWith(tree, "assistant", "Echo: first").entry);
		assert.equal(tree.current, nodeWith(tree, "assistant", "Echo: other").entry);
		// Both answers to "first"'s branch point stay in the tree.
		assert.equal(tree.nodes.filter((node) => node.parent === other.parent).length, 2);
	});

	it("gives a branch the main agent's tools", async () => {
		const tree = await (await treeRef()).tree(BACKGROUND_CONTEXT);
		const chat = await chatOf(tree.main);
		await chat.send({ text: 'ports {"action":"list"}', requestId: "ports" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (next) => toolResults(next).some((result) => result.toolName === "ports"));
		const result = toolResults(view).find((each) => each.toolName === "ports");
		assert.equal(result?.isError, false, JSON.stringify(result?.content));
		chat.release();
		await idle();
	});

	it("keeps the main agent's artifacts list across branches", async () => {
		const tree = await (await treeRef()).tree(BACKGROUND_CONTEXT);
		const chat = await chatOf(tree.main);
		await chat.send({ text: "artifact", requestId: "artifact" }, BACKGROUND_CONTEXT);
		await until(chat.view, (next) => toolResults(next).some((result) => result.toolName === "artifact"));
		chat.release();
		await idle();
		for (const conversation of [tree.main, 1]) {
			const list = owner.hold(ArtifactList, { session: session.id, conversation }, BACKGROUND_CONTEXT);
			await until(list.artifacts, (value) => value?.some((artifact) => artifact.name === "demo") ?? false);
			list.release();
		}
	});

	it("registers a branch's subagents on conversation 1 and reports to the branch", async () => {
		const tree = await (await treeRef()).tree(BACKGROUND_CONTEXT);
		const chat = await chatOf(tree.main);
		await chat.send({ text: "subagent", requestId: "subagent" }, BACKGROUND_CONTEXT);
		await until(chat.view, (next) => text(next).includes('<sender kind="subagent" name="helper"/>'));
		chat.release();
		await idle();
		const feed = await holdIn(owner, Subagents, {}, "reader");
		await until(
			feed.children,
			(children) => children?.[session.id]?.some((child) => child.name === "helper") ?? false,
		);
		feed.release();
	});

	it("reports to the branch that asked, also after a switch; team send to parent goes there too", async () => {
		const ref = await treeRef();
		const asking = (await ref.tree(BACKGROUND_CONTEXT)).main;
		const chat = await chatOf(asking);
		const spawn = { action: "spawn", name: "slowpoke", message: "slow-tool", tools: ["bash"] };
		await chat.send({ text: `subagent ${JSON.stringify(spawn)}`, requestId: "slowpoke" }, BACKGROUND_CONTEXT);
		await until(chat.view, (next) => text(next).includes("Started slowpoke."));
		// The subagent's bash call takes 4 seconds: the session switches meanwhile.
		await ref.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		await until(chat.view, (next) => text(next).includes('<sender kind="subagent" name="slowpoke"/>'));
		const feed = await holdIn(owner, Subagents, {}, "reader");
		const children = await until(
			feed.children,
			(value) => value?.[session.id]?.some((child) => child.name === "slowpoke") ?? false,
		);
		feed.release();
		const slowpoke = children?.[session.id]?.find((child) => child.name === "slowpoke")?.conversationId;
		assert(slowpoke !== undefined);
		const direct = await chatOf(slowpoke);
		const team = { action: "send", to: "parent", message: "for the asker", intent: "note" };
		await direct.send({ text: `team ${JSON.stringify(team)}`, requestId: "team-parent" }, BACKGROUND_CONTEXT);
		await until(chat.view, (next) => text(next).includes("[notes, no reply needed] for the asker"));
		direct.release();
		chat.release();
		await idle();
		const main = await chatOf(1);
		const view = await until(main.view, (next) => next !== null && next !== undefined);
		assert.doesNotMatch(text(view), /subagent slowpoke/);
		main.release();
		await ref.select({ conversation: asking }, BACKGROUND_CONTEXT);
		ref.release();
	});

	it("lists the branches in the session row and switches with select", async () => {
		const sessions = await sessionsRef();
		const rows = await until(
			sessions.sessions,
			(list) => (list.find((row) => row.id === session.id)?.branches.length ?? 0) === 2,
		);
		const row = rows.find((each) => each.id === session.id)!;
		// Newest first; the branch's first own message ("other") does not relabel it.
		assert.deepEqual(
			row.branches.map((branch) => branch.label),
			["second", null],
		);
		assert.equal(row.branches[0]!.conversation, row.main);
		const ref = await treeRef();
		await ref.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, (list) => list.find((each) => each.id === session.id)?.main === 1);
		await ref.select({ conversation: row.main }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, (list) => list.find((each) => each.id === session.id)?.main === row.main);
		await assert.rejects(ref.select({ conversation: 999 }, BACKGROUND_CONTEXT), /Unknown branch/);
	});

	it("switches back to a branch ending at the chosen answer without forking", async () => {
		const ref = await treeRef();
		const tree = await ref.tree(BACKGROUND_CONTEXT);
		const switched = await ref.navigate(
			{ entry: nodeWith(tree, "assistant", "Echo: second").entry },
			BACKGROUND_CONTEXT,
		);
		assert.deepEqual(switched, { conversation: 1, text: null });
		const after = await ref.tree(BACKGROUND_CONTEXT);
		assert.equal(after.main, 1);
		// No fork: the labels stay.
		assert.deepEqual(
			after.branches.map((branch) => branch.label),
			[null, "second"],
		);
		assert.equal(after.current, nodeWith(after, "assistant", "Echo: second").entry);
		await send(1, "third");
	});

	it("starts an empty conversation before the first message", async () => {
		const ref = await treeRef();
		const tree = await ref.tree(BACKGROUND_CONTEXT);
		const switched = await ref.navigate({ entry: nodeWith(tree, "user", "first").entry }, BACKGROUND_CONTEXT);
		assert.equal(switched.text, "first");
		assert.deepEqual((await ref.tree(BACKGROUND_CONTEXT)).branches.at(-1), {
			conversation: switched.conversation,
			label: "first",
		});
		const chat = await chatOf(switched.conversation);
		const view = await until(chat.view, (next) => next !== null && next !== undefined);
		assert.equal(view?.entries.length, 0);
		chat.release();
		// Its agent works: the model came along.
		const fresh = await send(switched.conversation, "fresh");
		assert.doesNotMatch(text(fresh), /Echo: first/);
		const after = await ref.tree(BACKGROUND_CONTEXT);
		assert.equal(nodeWith(after, "user", "fresh").parent, null);
	});

	it("labels a branch after an answer with that answer", async () => {
		const ref = await treeRef();
		const tree = await ref.tree(BACKGROUND_CONTEXT);
		const answer = nodeWith(tree, "assistant", "Echo: first");
		const switched = await ref.navigate({ entry: answer.entry }, BACKGROUND_CONTEXT);
		assert.equal(switched.text, null);
		const branches = await branchesWhen((list) => list.length === 4);
		assert.deepEqual(branches[0], { conversation: switched.conversation, label: "Echo: first" });
		// The nodes name the branch storing them: the fork's first message shows its label.
		await send(switched.conversation, "after the answer");
		const after = await ref.tree(BACKGROUND_CONTEXT);
		assert.equal(nodeWith(after, "user", "after the answer").conversation, switched.conversation);
		assert.equal(nodeWith(after, "user", "first").conversation, 1);
	});

	it("renames branches; conversation 1 goes back to the session title", async () => {
		const ref = await treeRef();
		const [, , second] = await branchesWhen((list) => list.length === 4);
		assert.equal(second?.label, "second");
		await ref.rename({ conversation: second!.conversation, label: "  Second\n  try " }, BACKGROUND_CONTEXT);
		await ref.rename({ conversation: 1, label: "Main line" }, BACKGROUND_CONTEXT);
		assert.deepEqual(
			(await branchesWhen((list) => list[3]?.label === "Main line")).map((branch) => branch.label).slice(2),
			["Second try", "Main line"],
		);
		await ref.rename({ conversation: 1, label: null }, BACKGROUND_CONTEXT);
		await branchesWhen((list) => list[3]?.label === null);
		await ref.rename({ conversation: 1, label: "Again" }, BACKGROUND_CONTEXT);
		await ref.rename({ conversation: 1, label: " " }, BACKGROUND_CONTEXT);
		assert.equal((await ref.tree(BACKGROUND_CONTEXT)).branches[0]?.label, null);
		await assert.rejects(
			ref.rename({ conversation: second!.conversation, label: " " }, BACKGROUND_CONTEXT),
			/at least one character/,
		);
		await assert.rejects(
			ref.rename({ conversation: second!.conversation, label: null }, BACKGROUND_CONTEXT),
			/at least one character/,
		);
		await assert.rejects(
			ref.rename({ conversation: second!.conversation, label: "x".repeat(201) }, BACKGROUND_CONTEXT),
			/at most 200 characters/,
		);
		await assert.rejects(ref.rename({ conversation: 999, label: "x" }, BACKGROUND_CONTEXT), /Unknown branch/);
		assert.equal((await ref.tree(BACKGROUND_CONTEXT)).branches[1]?.label, "Second try");
	});

	it("switches while the main conversation works; the branch left runs on, read-only, and stops", async () => {
		const ref = await treeRef();
		const tree = await ref.tree(BACKGROUND_CONTEXT);
		const left = tree.main;
		const chat = await chatOf(left);
		await chat.send({ text: "slow answer", requestId: "slow" }, BACKGROUND_CONTEXT);
		await until(chat.view, (next) => Boolean((next?.docs["pi.live"] as { run?: unknown } | undefined)?.run));
		await ref.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		const sessions = await sessionsRef();
		await until(sessions.sessions, (list) => list.find((each) => each.id === session.id)?.main === 1);
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await until(status.statuses, (value) => value?.[session.id]?.busy.includes(left) ?? false);
		status.release();
		await assert.rejects(
			chat.send({ text: "no", requestId: "no-left" }, BACKGROUND_CONTEXT),
			/earlier branch of the session/,
		);
		await chat.stop(BACKGROUND_CONTEXT);
		await until(chat.view, (next) => !(next?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		chat.release();
		await idle();
		await ref.select({ conversation: left }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, (list) => list.find((each) => each.id === session.id)?.main === left);
		await assert.rejects(ref.navigate({ entry: 999_999 }, BACKGROUND_CONTEXT), /Unknown message/);
		ref.release();
	});

	it("migrates p2.main version 1: labels start null, the worker fills the branches once from their fork points", async () => {
		assert.deepEqual(MainDoc.definition.migrate?.({ conversation: 3, branches: [1, 3] }, 1), {
			conversation: 3,
			branches: [
				{ conversation: 1, label: null },
				{ conversation: 3, label: null },
			],
		});
		const before = await branchesWhen((list) => list.length === 4);
		const [answer, empty, edit] = before.map((branch) => branch.conversation);
		// The worker stops (archived); its store gets `p2.main` as version 1 wrote it, then the session comes back.
		const sessions = await sessionsRef();
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		const context = durableContext(new AbortController().signal);
		const stored = await openSessionStorage(fixture.dataDir, session.id, context);
		const store = createSession(stored.storage);
		await store.commit(async (tx) => {
			await tx.retireDoc(MainDoc);
			Object.assign(await tx.doc(MainDocV1), { conversation: answer, branches: [1, edit, empty, answer] });
		}, context);
		await store.close(context);
		await stored.close();
		await sessions.restore({ id: session.id }, BACKGROUND_CONTEXT);
		const ref = await treeRef();
		await ref.tree(BACKGROUND_CONTEXT);
		// Fork points: the answer before "second" (Edit forked there), none (before the first message: its first own
		// user message), "Echo: first". Conversation 1 keeps null: the session title.
		assert.deepEqual(
			await branchesWhen((list) => list.find((branch) => branch.conversation === empty)?.label !== "first"),
			[
				{ conversation: answer, label: "Echo: first" },
				{ conversation: empty, label: "fresh" },
				{ conversation: edit, label: "Echo: first" },
				{ conversation: 1, label: null },
			],
		);
		ref.release();
	});
});
