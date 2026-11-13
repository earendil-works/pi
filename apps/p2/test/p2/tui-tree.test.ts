// `/tree` in the TUI (docs/tree.md): pi's tree selector over the session's branches with their labels (the session
// title for a null one) and pi's label key renaming the selected message's branch, `SessionTree.navigate` with the
// chosen user message in the editor of the conversation it switched to, double Escape (pi's default "tree"), a TUI
// following a switch made elsewhere (the session row's `main`), and Alt+Enter sending in a new branch when idle.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ConversationView,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui, { ChatSurface } from "../../plugins/chat/tui.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui from "../../plugins/sessions/tui.ts";
import { SessionTree, type TreeNode } from "../../plugins/tree/contract.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { type Cell, poll } from "./helpers.ts";
import { SESSION, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};
// Conversation 1: first → Echo first → second → Echo second; a branch after "Echo first": other → Echo other.
const NODES: TreeNode[] = [
	{ entry: 1, parent: null, conversation: 1, role: "user", text: "first question" },
	{ entry: 2, parent: 1, conversation: 1, role: "assistant", text: "Echo: first" },
	{ entry: 3, parent: 2, conversation: 1, role: "user", text: "second question" },
	{ entry: 4, parent: 3, conversation: 1, role: "assistant", text: "Echo: second" },
	{ entry: 6, parent: 2, conversation: 5, role: "user", text: "other" },
	{ entry: 7, parent: 6, conversation: 5, role: "assistant", text: "Echo: other" },
];
// Conversation 1 has no label of its own (the session title shows); the branch is named after its fork point.
const BRANCHES = [
	{ conversation: 1, label: null },
	{ conversation: 5, label: "Echo: first" },
];
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};
/** Alt+Enter as a legacy terminal sends it. */
const ALT_ENTER = "\x1b\r";
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
/** A conversation whose last entry is a finished answer: idle, with something to branch from. */
const answered = (conversation: number): ConversationView => ({
	conversation: { id: conversation } as ConversationView["conversation"],
	entries: [
		{
			id: 1 as EntryId,
			conversationId: ROOT_CONVERSATION_ID,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Echo: first" }],
					api: "openai-completions",
					provider: "faux",
					model: "faux-1",
					stopReason: "stop",
					timestamp: 1,
					usage: { ...USAGE, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
			],
		} as EntryRecord,
	],
	docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" } } } as ConversationView["docs"],
});

test("/tree switches branches with the chosen message in the editor; double Escape; following a switch", async (t) => {
	const navigated: number[] = [];
	const renamed: { conversation: number; label: string | null }[] = [];
	let rows: Cell<Session[]> | undefined;
	const setMain = (main: number) => rows?.replace(undefined as never, [{ ...SESSION, main }]);
	const view = (conversation: number): ConversationView => ({
		conversation: { id: conversation } as ConversationView["conversation"],
		entries: [],
		docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" } } } as ConversationView["docs"],
	});
	const { send, runtime, screen } = await topology(t, {
		server: [
			[
				Sessions,
				(_input, _principal, self) => {
					rows = self.state([SESSION]);
					return {
						variant: "owner",
						sessions: rows,
						defaultCwd: self.state("/work"),
						defaultEnv: self.state(null),
						operations: self.state([]),
						dismissOperation: () => {},
						create: () => SESSION,
						relocate: () => {},
						rename: () => {},
						pin: () => {},
						archive: () => {},
						restore: () => {},
						clone: () => SESSION,
						fork: () => SESSION,
					};
				},
			],
		],
		worker: [
			[
				Chat,
				(raw, _principal, self) => ({
					variant: "participant",
					view: self.state(view((raw as { conversation: number }).conversation)),
					model: self.state(META),
					liveShell: self.state(null),
					stats: self.state(null),
					entries: () => ({ items: [], more: false }),
					send: () => ({ submissionId: 1 }),
					stop: () => ({ restored: [] }),
					dequeue: () => ({ text: null }),
					configure: () => {},
					compact: () => ({ taskId: 1 }),
					abortCompaction: () => ({ aborted: 0 }),
					reset: () => {},
					dequeueOwn: () => ({ restored: [], skipped: 0 }),
					shell: () => ({ shellId: "x" }),
					abortShell: () => ({ aborted: false }),
				}),
			],
			[
				SessionTree,
				() => ({
					variant: "owner",
					tree: () => ({ nodes: NODES, branches: BRANCHES, main: 1, current: 4 }),
					select: () => {},
					rename: (change: { conversation: number; label: string | null }) => {
						renamed.push(change);
					},
					navigate: ({ entry }: { entry: number }) => {
						navigated.push(entry);
						setMain(5);
						return { conversation: 5, text: "second question" };
					},
					branch: () => ({ conversation: 5 }),
				}),
			],
		],
		facets: [tuiCoreFacet, chatTui, sessionsTui],
		columns: 100,
	});
	runtime.navigate("chat", "s");
	const chat = () => {
		const surface = runtime.ctx.surface("chat");
		assert(surface instanceof ChatSurface);
		return surface;
	};
	await poll(() => chat().editable);
	// pi's layout: the current branch first, a connector where "Echo: first" branches, the current one selected.
	typed(send, "/tree");
	send(ENTER);
	await poll(async () => (await screen()).includes("Session Tree"));
	const shown = await screen();
	// Each branch's label on its first own message: the session title for conversation 1.
	assert.match(shown, /• \[Fixture\] user: first question/);
	assert.match(shown, /├─ • user: second question/);
	assert.match(shown, /› .*• assistant: Echo: second/);
	assert.match(shown, /└─ \[Echo: first\] user: other/);
	assert.match(shown, /\(4\/6\)/);
	// pi's label key renames the branch holding the selected message.
	send("L");
	await poll(async () => (await screen()).includes("Branch label (empty: the session title):"));
	typed(send, BACKSPACE.repeat("Fixture".length));
	typed(send, "Main line");
	send(ENTER);
	await poll(() => renamed.length === 1);
	assert.deepEqual(renamed, [{ conversation: 1, label: "Main line" }]);
	await poll(async () => (await screen()).includes("[Main line] user: first question"));
	// Emptied: back to the session title.
	send("L");
	await poll(async () => (await screen()).includes("Branch label (empty: the session title):"));
	typed(send, BACKSPACE.repeat("Main line".length));
	send(ENTER);
	await poll(() => renamed.length === 2);
	assert.deepEqual(renamed[1], { conversation: 1, label: null });
	await poll(async () => (await screen()).includes("[Fixture] user: first question"));
	// Escape leaves the label input, not the tree.
	send(DOWN);
	send("L");
	await poll(async () => /Branch label:/.test(await screen()));
	send(ESC);
	await poll(async () => (await screen()).includes("(5/6)"));
	assert.equal(renamed.length, 2);
	// A user message: the session continues before it, its text in the editor of the conversation it switched to.
	send(UP);
	send(UP);
	send(ENTER);
	await poll(() => navigated.length === 1);
	assert.deepEqual(navigated, [3]);
	await poll(() => runtime.identity === "s#5");
	assert.equal(chat().editor.getText(), "second question");
	assert.equal(runtime.ctx.identity.main, 5);
	// Another device switches back: this TUI, viewing the previous main conversation, follows.
	setMain(1);
	await poll(() => runtime.identity === "s#1");
	// Double Escape on an empty editor opens the tree (pi's default action).
	await poll(() => chat().editable);
	chat().editor.setText("");
	send(ESC);
	send(ESC);
	await poll(async () => (await screen()).includes("Session Tree"));
	send(ESC);
	await poll(async () => !(await screen()).includes("Session Tree"));
});

test("Alt+Enter: idle, the message goes to a new branch and is sent there; busy stays a follow-up", async (t) => {
	const branched: { conversation: number; label: string }[] = [];
	const sent: { conversation: number; text: string; whenBusy?: string }[] = [];
	let rows: Cell<Session[]> | undefined;
	const views = new Map<number, Cell<ConversationView>>();
	const { send, runtime } = await topology(t, {
		server: [
			[
				Sessions,
				(_input, _principal, self) => {
					rows = self.state([SESSION]);
					return {
						variant: "owner",
						sessions: rows,
						defaultCwd: self.state("/work"),
						defaultEnv: self.state(null),
						operations: self.state([]),
						dismissOperation: () => {},
						create: () => SESSION,
						relocate: () => {},
						rename: () => {},
						pin: () => {},
						archive: () => {},
						restore: () => {},
						clone: () => SESSION,
						fork: () => SESSION,
					};
				},
			],
		],
		worker: [
			[
				Chat,
				(raw, _principal, self) => {
					const conversation = (raw as { conversation: number }).conversation;
					const view = self.state(answered(conversation));
					views.set(conversation, view);
					return {
						variant: "participant",
						view,
						model: self.state(META),
						liveShell: self.state(null),
						stats: self.state(null),
						entries: () => ({ items: [], more: false }),
						send: (input: { text: string; whenBusy?: string }) => {
							sent.push({
								conversation,
								text: input.text,
								...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
							});
							return { submissionId: 1 };
						},
						stop: () => ({ restored: [] }),
						dequeue: () => ({ text: null }),
						configure: () => {},
						compact: () => ({ taskId: 1 }),
						abortCompaction: () => ({ aborted: 0 }),
						reset: () => {},
						dequeueOwn: () => ({ restored: [], skipped: 0 }),
						shell: () => ({ shellId: "x" }),
						abortShell: () => ({ aborted: false }),
					};
				},
			],
			[
				SessionTree,
				() => ({
					variant: "owner",
					tree: () => ({ nodes: [], branches: BRANCHES, main: 1, current: null }),
					select: () => {},
					rename: () => {},
					navigate: () => ({ conversation: 1, text: null }),
					branch: (change: { conversation: number; label: string }) => {
						branched.push(change);
						rows?.replace(undefined as never, [{ ...SESSION, main: 6 }]);
						return { conversation: 6 };
					},
				}),
			],
		],
		facets: [tuiCoreFacet, chatTui, sessionsTui],
		columns: 100,
	});
	runtime.navigate("chat", "s");
	const chat = () => {
		const surface = runtime.ctx.surface("chat");
		assert(surface instanceof ChatSurface);
		return surface;
	};
	await poll(() => chat().editable);
	typed(send, "a side question");
	send(ALT_ENTER);
	await poll(() => sent.length === 1);
	assert.deepEqual(branched, [{ conversation: 1, label: "a side question" }]);
	assert.equal(runtime.identity, "s#6");
	assert.deepEqual(sent, [{ conversation: 6, text: "a side question", whenBusy: "steer" }]);
	assert.equal(chat().editor.getText(), "");
	assert.equal(runtime.drafts.get("s#1") ?? "", "");
	// While a run is busy, Alt+Enter queues a follow-up in the conversation shown.
	const busy = answered(6);
	views.get(6)?.replace(undefined as never, { ...busy, docs: { ...busy.docs, "pi.live": { run: { id: 1 } } } });
	await poll(() => [...chat().contexts()].includes("busy"));
	typed(send, "later");
	send(ALT_ENTER);
	await poll(() => sent.length === 2);
	assert.deepEqual(sent[1], { conversation: 6, text: "later", whenBusy: "followUp" });
	assert.equal(branched.length, 1);
});
