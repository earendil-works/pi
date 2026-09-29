import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Conversation,
	ConversationConfig,
	type ConversationId,
	createRegistry,
	createSession,
	defineDoc,
	defineEntry,
	defineTask,
	type EntryRecord,
	LiveDoc,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { openHarness, tool, user } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

const directories = new Set<string>();

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
	it("creates the root lazily with its configuration and init in one commit", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openHarness(storage, ["read", "bash"]);
		expect(storage.commits).toHaveLength(0);
		const root = await harness.root(context, {
			init: async (tx, id) => {
				(await tx.doc(NoteDoc, id)).text = "root note";
				(await tx.doc(ConversationConfig, id)).thinkingLevel = "high";
			},
		});
		expect(root.id).toBe(ROOT_CONVERSATION_ID);
		expect(storage.commits).toHaveLength(1);
		// Conversation, pi.live, pi.inbox, pi.usage, configuration, and the init note.
		expect(storage.commits[0]!.map((write) => write.type)).toEqual([
			"conversation",
			"document.create",
			"document.create",
			"document.create",
			"document.create",
			"document.create",
		]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect(await root.getActiveTools(context)).toEqual(["read", "bash"]);
		expect(await root.getThinkingLevel(context)).toBe("high");
		expect(await harness.snapshot(NoteDoc, root.id, context)).toEqual({ text: "root note" });

		expect((await harness.root(context, { init: () => expect.unreachable() })).id).toBe(root.id);
		expect(storage.commits).toHaveLength(1);
		await harness.close(context);
	});

	it("keeps root and conversation identity and state across reopen", async () => {
		const path = await sqlitePath();
		let first = await openHarness(await openNodeSqliteStorage(path), ["read"]);
		const root = await first.harness.root(context);
		await root.setModel({ provider: "anthropic", modelId: "claude" }, context);
		const entry = await append(root, "hello");
		const child = await first.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		await first.harness.close(context);
		await expect(root.getModel(context)).rejects.toThrow();

		first = await openHarness(await openNodeSqliteStorage(path), []);
		const reopened = await first.harness.root(context, { init: () => expect.unreachable() });
		expect(reopened.id).toBe(ROOT_CONVERSATION_ID);
		expect(await reopened.getModel(context)).toEqual({ provider: "anthropic", modelId: "claude" });
		expect(await reopened.getActiveTools(context)).toEqual(["read"]);
		expect(await allEntries(reopened)).toEqual(["hello"]);
		expect((await first.harness.conversation(child.id, context))?.id).toBe(child.id);
		const reopenedFork = await first.harness.conversation(fork.id, context);
		expect(await allEntries(reopenedFork!)).toEqual(["hello"]);
		expect(await reopenedFork!.getModel(context)).toEqual({ provider: "anthropic", modelId: "claude" });
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
		expect(await created.getActiveTools(context)).toEqual(["read"]);

		const before = storage.commits.length;
		await expect(
			harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					init: () => {
						throw new Error("init failed");
					},
				},
				context,
			),
		).rejects.toThrow("init failed");
		await expect(
			harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					init: async (tx, id) => {
						(await tx.doc(ConversationConfig, id)).activeTools.push("missing");
					},
				},
				context,
			),
		).rejects.toThrow("Tools are not registered: missing");
		expect(storage.commits).toHaveLength(before);

		registry.tools.add(tool("bash"));
		const later = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		expect(await later.getActiveTools(context)).toEqual(["read", "bash"]);
		expect(await created.getActiveTools(context)).toEqual(["read"]);
		await harness.close(context);
	});

	it("forks at a concrete entry with as-of configuration and init overrides", async () => {
		const { harness, registry } = await openHarness(new MemoryStorage(), ["read"]);
		const legacy = registry.tools.add(tool("legacy"));
		const root = await harness.root(context);
		await root.setThinkingLevel("low", context);
		const at = await append(root, "one");
		await root.setThinkingLevel("high", context);
		await root.setActiveTools(["read"], context);
		await append(root, "two");
		legacy.dispose();

		const child = await root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
		expect(await child.getThinkingLevel(context)).toBe("low");
		expect(await child.getActiveTools(context)).toEqual(["read", "legacy"]);
		expect(await allEntries(child)).toEqual(["one"]);

		const overridden = await root.fork(
			at.id,
			{
				ownership: { kind: "ownerless" },
				init: async (tx, id) => {
					const config = await tx.doc(ConversationConfig, id);
					config.thinkingLevel = "minimal";
					config.activeTools = ["legacy"];
				},
			},
			context,
		);
		expect(await overridden.getThinkingLevel(context)).toBe("minimal");
		expect(await overridden.getActiveTools(context)).toEqual(["legacy"]);
		expect(await root.getThinkingLevel(context)).toBe("high");

		const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await expect(root.fork(at.id, { ownership: { kind: "ownerless" } }, context)).resolves.toBeDefined();
		await expect(unrelated.fork(at.id, { ownership: { kind: "ownerless" } }, context)).rejects.toThrow(
			"is not visible",
		);
		await harness.close(context);
	});

	it("inherits unavailable active tools through forks without revalidating them", async () => {
		const { harness, registry } = await openHarness(new MemoryStorage(), []);
		const legacy = registry.tools.add(tool("legacy"));
		registry.tools.add(tool("read"));
		const root = await harness.root(context);
		const at = await append(root, "one");
		legacy.dispose();
		const child = await root.fork(
			at.id,
			{
				ownership: { kind: "ownerless" },
				init: async (tx, id) => {
					(await tx.doc(ConversationConfig, id)).thinkingLevel = "low";
				},
			},
			context,
		);
		expect(await child.getActiveTools(context)).toEqual(["legacy", "read"]);
		await expect(
			root.fork(
				at.id,
				{
					ownership: { kind: "ownerless" },
					init: async (tx, id) => {
						(await tx.doc(ConversationConfig, id)).activeTools = ["read", "gone"];
					},
				},
				context,
			),
		).rejects.toThrow("Tools are not registered: gone");

		// Raw writes are trusted: an inherited duplicate forks with or without init.
		await root.commit(async (tx) => {
			(await tx.doc(ConversationConfig, root.id)).activeTools = ["read", "read"];
		}, context);
		const duplicated = await append(root, "two");
		for (const init of [undefined, () => {}]) {
			const copy = await root.fork(
				duplicated.id,
				{ ownership: { kind: "ownerless" }, ...(init === undefined ? {} : { init }) },
				context,
			);
			expect(await copy.getActiveTools(context)).toEqual(["read", "read"]);
		}
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
		const taskId = await conversation.commit((tx) => tx.createTask(task, { n: 1 }), context);
		const record = await harness.commit((tx) => tx.task(taskId), context);
		expect(record?.conversationId).toBe(conversation.id);
		await expect(harness.commit((tx) => tx.createTask(task, { n: 2 }), context)).rejects.toThrow(
			"requires options.conversationId",
		);
		await harness.close(context);
	});
});

describe("Harness configuration", () => {
	it("gets and sets model, thinking level, and active tools", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openHarness(storage, ["read", "bash", "edit"]);
		const root = await harness.root(context);
		expect(await root.getModel(context)).toBeUndefined();
		expect(await root.getThinkingLevel(context)).toBe("off");

		await root.setModel({ provider: "openai", modelId: "gpt" }, context);
		expect(await root.getModel(context)).toEqual({ provider: "openai", modelId: "gpt" });
		await root.setModel(undefined, context);
		expect(await root.getModel(context)).toBeUndefined();

		await root.setThinkingLevel("medium", context);
		expect(await root.getThinkingLevel(context)).toBe("medium");

		await root.setActiveTools(["edit", "read"], context);
		expect(await root.getActiveTools(context)).toEqual(["edit", "read"]);
		const commits = storage.commits.length;
		await expect(root.setActiveTools(["read", "read"], context)).rejects.toThrow("more than once");
		await expect(root.setActiveTools(["read", "unknown"], context)).rejects.toThrow(
			"Tools are not registered: unknown",
		);
		expect(storage.commits).toHaveLength(commits);
		expect(await root.getActiveTools(context)).toEqual(["edit", "read"]);
		await harness.close(context);
	});

	it("keeps stale unregistered names on later edits", async () => {
		const { harness, registry } = await openHarness(new MemoryStorage(), ["read"]);
		const legacy = registry.tools.add(tool("legacy"));
		const root = await harness.root(context);
		legacy.dispose();
		expect(await root.getActiveTools(context)).toEqual(["read", "legacy"]);
		await root.setActiveTools(["legacy"], context);
		await root.setThinkingLevel("low", context);
		// Raw document writes are trusted and unchecked.
		await root.commit(async (tx) => {
			(await tx.doc(ConversationConfig, root.id)).activeTools.push("anything");
		}, context);
		expect(await root.getActiveTools(context)).toEqual(["legacy", "anything"]);
		await harness.close(context);
	});

	it("stages the built-in documents for conversations created or forked through Tx", async () => {
		const { harness } = await openHarness(new MemoryStorage(), ["read"]);
		const id = await harness.commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		const created = (await harness.conversation(id, context))!;
		expect(await created.getActiveTools(context)).toEqual(["read"]);
		expect(await harness.snapshot(LiveDoc, id, context)).toEqual({});

		await created.setActiveTools([], context);
		const at = await created.commit(
			async (tx) => (await tx.appendEntry(id, { kind: "message", model: [user("again")] })).id,
			context,
		);
		await created.commit(async (tx) => {
			(await tx.doc(LiveDoc, id)).run = { taskId: 99 as TaskId, inputs: [] };
		}, context);
		const forkId = await harness.commit(
			async (tx) => (await tx.forkConversation(id, at, { ownership: { kind: "ownerless" } })).id,
			context,
		);
		const fork = (await harness.conversation(forkId, context))!;
		// A fork copies the configuration at its fork entry, not the registry default, and starts with an empty pi.live.
		expect(await fork.getActiveTools(context)).toEqual([]);
		expect(await harness.snapshot(LiveDoc, forkId, context)).toEqual({});
		await harness.close(context);
	});

	it("runs registered conversation setups after the built-in one on every creation path", async () => {
		const Agent = defineDoc<{ kind: string; forks: number }>({
			kind: "test.agent",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ kind: "main", forks: 0 }),
		});
		const registry = createRegistry();
		const order: string[] = [];
		registry.conversations.setup("agent", async (tx, conversation) => {
			order.push(`agent:${conversation.id}`);
			const agent = await tx.doc(Agent, conversation.id);
			// A fork keeps its copied document; the setup only records the fork.
			if (conversation.parent !== undefined) agent.forks++;
		});
		expect(
			registry
				.snapshot()
				.conversationSetups()
				.map(({ key }) => key),
		).toEqual(["pi", "agent"]);
		expect(() => registry.conversations.setup("agent", () => {})).toThrow("Setup agent is already registered");
		const { harness } = await openHarness(new MemoryStorage(), [], { registry });
		const root = await harness.root(context, {
			init: async (tx, id) => {
				// Host init runs after every setup, so the agent document already exists.
				expect(order).toEqual([`agent:${id}`]);
				(await tx.doc(Agent, id)).kind = "root";
			},
		});
		const raw = await root.commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		const at = await root.commit(async (tx) => (await tx.appendEntry(root.id, { kind: "note" })).id, context);
		const fork = await root.fork(at, { ownership: { kind: "ownerless" } }, context);
		expect(await harness.snapshot(Agent, root.id, context)).toEqual({ kind: "root", forks: 0 });
		expect(await harness.snapshot(Agent, raw, context)).toEqual({ kind: "main", forks: 0 });
		expect(await harness.snapshot(Agent, fork.id, context)).toEqual({ kind: "root", forks: 1 });
		expect(await harness.snapshot(LiveDoc, raw, context)).toEqual({});
		expect(order).toEqual([`agent:${root.id}`, `agent:${raw}`, `agent:${fork.id}`]);

		registry.conversations.setup("broken", () => {
			throw new Error("setup failed");
		});
		const count = async () => (await harness.commit((tx) => tx.scanConversations({}, 100), context)).items.length;
		const before = await count();
		await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toThrow(
			"setup failed",
		);
		// The whole creating commit rolled back.
		expect(await count()).toBe(before);
		await harness.close(context);
	});

	it("reads initial configuration for conversations a plain Session created", async () => {
		const storage = new ControlledStorage();
		const id = await createSession(storage).commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		const { harness } = await openHarness(storage, ["read"]);
		const raw = await harness.conversation(id, context);
		expect(await harness.snapshot(LiveDoc, id, context)).toBeUndefined();
		expect(await raw!.getThinkingLevel(context)).toBe("off");
		expect(await raw!.getActiveTools(context)).toEqual([]);
		const commits = storage.commits.length;
		expect(await raw!.getModel(context)).toBeUndefined();
		expect(storage.commits).toHaveLength(commits);
		await raw!.setActiveTools(["read"], context);
		expect(await raw!.getActiveTools(context)).toEqual(["read"]);
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
