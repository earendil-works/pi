import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	configure,
	createRegistry,
	createSession,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	type EntryRecord,
	Harness,
	LiveDoc,
	MemoryStorage,
	ProviderDoc,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { addTool, openHarness, tool, user } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

const directories = new Set<string>();
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-harness-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

const NoteDoc = defineDoc<{ text: string }>({
	kind: "test.note",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

const Message = defineEntry("message");

async function append(conversation: Conversation, text: string): Promise<EntryRecord> {
	return conversation.commit(
		(tx) => tx.appendEntry(conversation.id, { kind: "message", model: [user(text)] }),
		context,
	);
}

async function allEntries(conversation: Conversation): Promise<string[]> {
	const texts: string[] = [];
	let cursor: Parameters<Conversation["entries"]>[2];
	do {
		const page = await conversation.entries({}, 2, cursor, context);
		for (const entry of page.items) texts.push((entry.model?.[0] as { content: string }).content);
		cursor = page.next;
	} while (cursor !== undefined);
	return texts;
}

describe("Harness root and conversations", () => {
	it("creates the root lazily with its agent change and init in one commit", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openHarness(storage, ["read", "bash"]);
		expect(storage.commits).toHaveLength(0);
		const root = await harness.root(context, {
			agent: { thinkingLevel: "high" },
			init: async (tx, id) => {
				// The agent change applied before init.
				expect((await tx.doc(AgentDoc, id)).thinkingLevel).toBe("high");
				(await tx.doc(NoteDoc, id)).text = "root note";
			},
		});
		expect(root.id).toBe(ROOT_CONVERSATION_ID);
		expect(storage.commits).toHaveLength(1);
		// Conversation, five built-in documents, and the init note.
		expect(storage.commits[0]!.map((write) => write.type)).toEqual([
			"conversation",
			"document.create",
			"document.create",
			"document.create",
			"document.create",
			"document.create",
			"document.create",
		]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect(await harness.snapshot(ProviderDoc, root.id, context)).toEqual({
			sessionId: expect.stringMatching(UUID_V7),
		});
		expect(await harness.snapshot(AgentDoc, root.id, context)).toEqual({ thinkingLevel: "high" });
		const agent = await root.agent(context);
		expect(agent.thinkingLevel).toBe("high");
		expect(agent.tools.map((each) => each.name)).toEqual(["read", "bash"]);
		expect(await harness.snapshot(NoteDoc, root.id, context)).toEqual({ text: "root note" });

		const again = await harness.root(context, { agent: { thinkingLevel: "low" }, init: () => expect.unreachable() });
		expect(again.id).toBe(root.id);
		expect(storage.commits).toHaveLength(1);
		await harness.close(context);
	});

	it("keeps root and conversation identity and state across reopen", async () => {
		const path = await sqlitePath();
		let first = await openHarness(await openNodeSqliteStorage(path), ["read"]);
		const root = await first.harness.root(context);
		await root.configure({ model: { provider: "anthropic", modelId: "claude" }, cwd: "/repo" }, context);
		const entry = await append(root, "hello");
		const child = await first.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		const providerSessionIds = await Promise.all(
			[root, child, fork].map(
				async (conversation) => (await first.harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId,
			),
		);
		// Regression coverage for #10424: a fork must not inherit its parent's provider identity.
		for (const sessionId of providerSessionIds) expect(sessionId).toMatch(UUID_V7);
		expect(new Set(providerSessionIds).size).toBe(3);
		await first.harness.close(context);
		await expect(root.agent(context)).rejects.toThrow();

		// The new process installs nothing: the stored choices survive, the tools do not resolve.
		first = await openHarness(await openNodeSqliteStorage(path), []);
		const reopened = await first.harness.root(context, { init: () => expect.unreachable() });
		expect(reopened.id).toBe(ROOT_CONVERSATION_ID);
		expect(await reopened.agent(context)).toMatchObject({
			model: { provider: "anthropic", modelId: "claude" },
			cwd: "/repo",
			tools: [],
		});
		expect(await allEntries(reopened)).toEqual(["hello"]);
		expect((await first.harness.conversation(child.id, context))?.id).toBe(child.id);
		await expect(
			Promise.all(
				[root.id, child.id, fork.id].map(
					async (id) => (await first.harness.snapshot(ProviderDoc, id, context))?.sessionId,
				),
			),
		).resolves.toEqual(providerSessionIds);
		const reopenedFork = await first.harness.conversation(fork.id, context);
		expect(await allEntries(reopenedFork!)).toEqual(["hello"]);
		expect((await reopenedFork!.agent(context)).model).toEqual({ provider: "anthropic", modelId: "claude" });
		expect(await first.harness.conversation(999 as ConversationId, context)).toBeUndefined();
		await first.harness.close(context);
	});

	it("creates independent conversations atomically with init and rolls back failures", async () => {
		const storage = new ControlledStorage();
		const { harness, registry } = await openHarness(storage, ["read"]);
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				init: async (tx, id) => {
					await tx.appendEntry(id, { kind: "message", model: [user("seed")] });
				},
			},
			context,
		);
		expect(storage.commits).toHaveLength(1);
		expect(await allEntries(created)).toEqual(["seed"]);

		const before = storage.commits.length;
		await expect(
			harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { thinkingLevel: "high" },
					init: () => {
						throw new Error("init failed");
					},
				},
				context,
			),
		).rejects.toThrow("init failed");
		expect(storage.commits).toHaveLength(before);

		// A conversation on the default selection follows installs live.
		addTool(registry, tool("bash"));
		const names = async (conversation: Conversation) =>
			(await conversation.agent(context)).tools.map((each) => each.name);
		expect(await names(created)).toEqual(["read", "bash"]);
		await harness.close(context);
	});

	it("forks at a concrete entry with the as-of agent and applies agent and init overrides", async () => {
		const { harness, registry } = await openHarness(new MemoryStorage(), ["read"]);
		const legacy = tool("legacy");
		addTool(registry, legacy);
		const root = await harness.root(context);
		await root.configure({ thinkingLevel: "low" }, context);
		const at = await append(root, "one");
		await root.configure({ thinkingLevel: "high", tools: [tool("read")] }, context);
		await append(root, "two");

		const child = await root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
		expect(await harness.snapshot(AgentDoc, child.id, context)).toEqual({ thinkingLevel: "low" });
		expect(await allEntries(child)).toEqual(["one"]);

		const overridden = await root.fork(
			at.id,
			{
				ownership: { kind: "ownerless" },
				agent: { thinkingLevel: "minimal", tools: [legacy] },
				init: async (tx, id) => {
					expect((await tx.doc(AgentDoc, id)).thinkingLevel).toBe("minimal");
				},
			},
			context,
		);
		expect(await harness.snapshot(AgentDoc, overridden.id, context)).toEqual({
			thinkingLevel: "minimal",
			tools: ["legacy"],
		});
		expect(await harness.snapshot(AgentDoc, root.id, context)).toEqual({ thinkingLevel: "high", tools: ["read"] });

		const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await expect(root.fork(at.id, { ownership: { kind: "ownerless" } }, context)).resolves.toBeDefined();
		await expect(unrelated.fork(at.id, { ownership: { kind: "ownerless" } }, context)).rejects.toThrow(
			"is not visible",
		);
		await harness.close(context);
	});

	it("paginates fork-aware history through deep ancestor caps and same-commit prefixes", async () => {
		const { harness } = await openHarness(new MemoryStorage());
		const root = await harness.root(context);
		await append(root, "r1");
		const [r2] = await root.commit(
			async (tx) => [
				await tx.appendEntry(root.id, { kind: "message", model: [user("r2")] }),
				await tx.appendEntry(root.id, { kind: "message", model: [user("r3")] }),
			],
			context,
		);
		const child = await root.fork(r2!.id, { ownership: { kind: "ownerless" } }, context);
		const c1 = await append(child, "c1");
		await append(child, "c2");
		const grandchild = await child.fork(c1.id, { ownership: { kind: "ownerless" } }, context);
		await append(grandchild, "g1");

		expect(await allEntries(root)).toEqual(["r3", "r2", "r1"]);
		expect(await allEntries(child)).toEqual(["c2", "c1", "r2", "r1"]);
		expect(await allEntries(grandchild)).toEqual(["g1", "c1", "r2", "r1"]);
		const bounded = await grandchild.entries(
			{ minEntryId: r2!.id, maxEntryId: c1.id, conversationId: root.id } as never,
			10,
			undefined,
			context,
		);
		expect(bounded.items.map((entry) => entry.id)).toEqual([c1.id, r2!.id]);
		expect(Message.is(bounded.items[0])).toBe(true);
		expect(Message.is(undefined)).toBe(false);
		await harness.close(context);
	});

	it("binds commits and task creation to the conversation", async () => {
		const { harness } = await openHarness(new MemoryStorage());
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const task = defineTask<{ n: number }, { phase: "run" }, null>({
			name: "test.work",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: async () => {} },
			abort: async () => {},
		});
		const taskId = await conversation.commit(
			(tx) => tx.createTask(task, { n: 1 }, { ownership: { kind: "conversation" } }),
			context,
		);
		const record = await harness.commit((tx) => tx.task(taskId), context);
		expect(record?.conversationId).toBe(conversation.id);
		await expect(
			harness.commit((tx) => tx.createTask(task, { n: 2 }, { ownership: { kind: "conversation" } }), context),
		).rejects.toThrow("requires options.conversationId");
		await harness.close(context);
	});

	it("runs conversationCreated in every creating commit, after the built-ins and before agent and init", async () => {
		const seen: string[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry: createRegistry(),
				conversationCreated: async (tx, conversation) => {
					const agent = await tx.doc(AgentDoc, conversation.id);
					seen.push(`${conversation.id}:${conversation.parent === undefined ? "new" : "fork"}:${agent.cwd}`);
					(await tx.doc(NoteDoc, conversation.id)).text ||= "created";
					if (agent.cwd === "/fail") throw new Error("no");
				},
			},
			context,
		);
		const root = await harness.root(context, {
			agent: { cwd: "/root" },
			init: async (tx, id) => void seen.push(`init:${(await tx.doc(NoteDoc, id)).text}`),
		});
		// A raw creation in a commit, as in a tool, and a fork, which already has the asOf copies.
		const raw = await harness.commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		const entry = await append(root, "hello");
		const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		expect(seen).toEqual([
			`${root.id}:new:undefined`,
			"init:created",
			`${raw}:new:undefined`,
			`${fork.id}:fork:/root`,
		]);
		expect(await harness.snapshot(NoteDoc, raw, context)).toEqual({ text: "created" });
		// A throw fails the creating commit.
		await root.configure({ cwd: "/fail" }, context);
		await expect(root.fork(entry.id, { ownership: { kind: "ownerless" } }, context)).resolves.toBeDefined();
		const failing = await append(root, "after");
		await expect(root.fork(failing.id, { ownership: { kind: "ownerless" } }, context)).rejects.toThrow("no");
		await harness.close(context);
	});
});

describe("Harness agent", () => {
	it("replaces whole fields, clears them with null, and leaves undefined fields alone", async () => {
		const { harness, registry } = await openHarness(new MemoryStorage());
		const read = tool("read");
		const bash = tool("bash");
		const edit = tool("edit");
		registry.install(defineExtension({ name: "coding", tools: [read, bash, edit] }));
		const root = await harness.root(context);
		const stored = () => harness.snapshot(AgentDoc, root.id, context);
		const offered = async () => (await root.agent(context)).tools.map((each) => each.name);
		expect(await root.agent(context)).toMatchObject({ thinkingLevel: "off", tools: [read, bash, edit] });
		expect((await root.agent(context)).model).toBeUndefined();

		await root.configure({ model: { provider: "openai", modelId: "gpt" }, thinkingLevel: "medium" }, context);
		await root.configure({ model: undefined, instructions: "Be terse." }, context);
		expect(await stored()).toEqual({
			model: { provider: "openai", modelId: "gpt" },
			thinkingLevel: "medium",
			instructions: "Be terse.",
		});
		await root.configure({ model: null, instructions: null }, context);
		expect(await stored()).toEqual({ thinkingLevel: "medium" });

		await root.configure({ tools: { remove: [edit] } }, context);
		expect(await offered()).toEqual(["read", "bash"]);
		// A new filter replaces the old one: edit is offered again.
		await root.configure({ tools: { remove: [bash] } }, context);
		expect(await offered()).toEqual(["read", "edit"]);
		await root.configure({ tools: [edit, read] }, context);
		expect(await offered()).toEqual(["edit", "read"]);
		await root.configure({ tools: null }, context);
		expect(await offered()).toEqual(["read", "bash", "edit"]);
		// Names are stored without checking the registry.
		await root.configure({ tools: [tool("missing"), read] }, context);
		expect(await stored()).toMatchObject({ tools: ["missing", "read"] });
		expect(await offered()).toEqual(["read"]);
		await harness.close(context);
	});

	it("gives conversations created through Tx their documents: empty, an owner copy, or the fork's as-of copy", async () => {
		const { harness } = await openHarness(new MemoryStorage(), ["read"]);
		const root = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "m" }, instructions: "Main role.", cwd: "/repo" },
		});
		const owner = defineTask<Record<string, never>, { phase: "never" }, null>({
			name: "test.owner",
			version: 1,
			initial: () => ({ phase: "never" }),
			phases: { never: async () => {} },
			abort: async () => {},
		});
		const ids = await root.commit(async (tx) => {
			const taskId = await tx.createTask(owner, {}, { ownership: { kind: "conversation" } });
			const plain = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const owned = await tx.createConversation({ ownership: { kind: "task", taskId } });
			// The copy exists when createConversation() returns, so a configure() in the same callback overrides it.
			expect((await tx.doc(AgentDoc, owned.id)).cwd).toBe("/repo");
			await configure(tx, owned.id, { cwd: "/worktree" });
			return { taskId, plain: plain.id, owned: owned.id };
		}, context);
		expect(await harness.snapshot(AgentDoc, ids.plain, context)).toEqual({});
		expect(await harness.snapshot(LiveDoc, ids.plain, context)).toEqual({});
		expect(await harness.snapshot(ProviderDoc, ids.plain, context)).toEqual({
			sessionId: expect.stringMatching(UUID_V7),
		});
		expect((await harness.snapshot(ProviderDoc, ids.owned, context))?.sessionId).not.toBe(
			(await harness.snapshot(ProviderDoc, root.id, context))?.sessionId,
		);
		expect(await harness.snapshot(AgentDoc, ids.owned, context)).toEqual({
			model: { provider: "faux", modelId: "m" },
			instructions: "Main role.",
			cwd: "/worktree",
		});

		// A later owner change does not reach the child.
		await root.configure({ thinkingLevel: "high" }, context);
		expect((await harness.snapshot(AgentDoc, ids.owned, context))?.thinkingLevel).toBeUndefined();

		// A task-owned fork keeps its as-of copy of its fork parent, not its owner's agent.
		const at = await root.commit(async (tx) => (await tx.appendEntry(ids.plain, { kind: "note" })).id, context);
		const fork = await root.commit(
			async (tx) =>
				(await tx.forkConversation(ids.plain, at, { ownership: { kind: "task", taskId: ids.taskId } })).id,
			context,
		);
		expect(await harness.snapshot(AgentDoc, fork, context)).toEqual({});
		expect(await harness.snapshot(LiveDoc, fork, context)).toEqual({});
		expect((await harness.snapshot(ProviderDoc, fork, context))?.sessionId).not.toBe(
			(await harness.snapshot(ProviderDoc, ids.plain, context))?.sessionId,
		);
		await harness.close(context);
	});

	it("reads an absent agent for conversations a plain Session created without writing", async () => {
		const storage = new ControlledStorage();
		const id = await createSession(storage).commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		const { harness } = await openHarness(storage, ["read"]);
		const raw = await harness.conversation(id, context);
		expect(await harness.snapshot(LiveDoc, id, context)).toBeUndefined();
		const commits = storage.commits.length;
		expect(await raw!.agent(context)).toMatchObject({ thinkingLevel: "off", tools: [{ name: "read" }] });
		expect(storage.commits).toHaveLength(commits);
		await raw!.configure({ thinkingLevel: "low" }, context);
		expect(await harness.snapshot(AgentDoc, id, context)).toEqual({ thinkingLevel: "low" });
		await harness.close(context);
	});
});

describe("Harness lifecycle", () => {
	it("returns stateless handles and rejects operations after close", async () => {
		const { harness } = await openHarness(new MemoryStorage());
		const root = await harness.root(context);
		const again = await harness.root(context);
		expect(again).not.toBe(root);
		expect(again.id).toBe(root.id);
		await harness.close(context);
		await expect(harness.root(context)).rejects.toThrow("Harness is closed");
		await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toThrow(
			"Harness is closed",
		);
		await expect(harness.conversation(root.id, context)).rejects.toThrow("Harness is closed");
	});

	it("forwards generic Session document APIs", async () => {
		const { harness } = await openHarness(new MemoryStorage());
		const root = await harness.root(context);
		const entry = await root.commit(async (tx) => {
			(await tx.doc(NoteDoc, root.id)).text = "first";
			return tx.appendEntry(root.id, { kind: "message", model: [user("m")] });
		}, context);
		await harness.commit(async (tx) => {
			(await tx.doc(NoteDoc, root.id)).text = "second";
		}, context);
		expect(await harness.snapshot(NoteDoc, root.id, context)).toEqual({ text: "second" });
		expect(await harness.snapshotAsOf(NoteDoc, root.id, entry.id, context)).toEqual({ text: "first" });
		const state = await harness.documentState(NoteDoc, root.id, context);
		expect(state?.value).toEqual({ text: "second" });
		state?.dispose();
		await harness.close(context);
	});
});
