// `/tree` in the session worker (`docs/tree.md`): the tree of the top-level conversations' messages, switching the
// current main conversation (forking a new branch where none ends at the chosen point), and the rules that come with
// it: older branches are read-only, branches carry stored labels, and the session catalog follows `p2.main`, pushed by
// the worker inside the method that changed it.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Harness,
	type JsonObject,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import {
	type AcceptsTable,
	agentMessage,
	type Context,
	type Ctx,
	contribute,
	defineFacet,
	expectVariant,
	forbidden,
	isOwner,
	messageData,
	peerMessage,
} from "@p2/app/v1";
import {
	harnessOf,
	isTopLevel,
	MainDoc,
	mainConversation,
	ReadOnlyConversations,
	topLevelConversations,
	topLevelRecords,
	workerOf,
} from "@p2/app/v1/worker";
import { type Branch, Sessions } from "../sessions/contract.ts";
import { PREVIEW_LENGTH, SessionTree, type Tree, type TreeNode } from "./contract.ts";

/**
 * Consumers loaded before a deploy: `SessionTree` v1 (the tree without branch labels) and v2 (no `branch`, nothing to
 * map).
 */
const TREE_ACCEPTS: AcceptsTable<typeof SessionTree> = {
	2: {},
	1: {
		methods: {
			tree: {
				result: ({ nodes, main, current }) => ({
					nodes: nodes.map(({ entry, parent, role, text }) => ({ entry, parent, role, text })),
					main,
					current,
				}),
			},
		},
	},
};

const NOT_CURRENT = "This is an earlier branch of the session: switch to it with /tree to continue it";

export default defineFacet((host) => {
	contribute(host, "p2.tree-branches", (self) => {
		const harness = harnessOf(self);
		// Only the current main conversation takes input: an earlier branch shows its history, and a run it still has goes
		// on in the background (Stop stays allowed).
		self.contribute(ReadOnlyConversations, {
			tree: async (conversation, ctx) => {
				const durable = harness().durable;
				const id = conversation as ConversationId;
				return id !== (await mainConversation(durable, ctx)) && (await isTopLevel(durable, id, ctx))
					? NOT_CURRENT
					: undefined;
			},
		});
		// The catalog follows `p2.main` (the main conversation, the branches and their labels): the methods changing it
		// push it before they answer (`reportTree`); at start the worker pushes it once, which also covers a worker that
		// stopped between a change and its push. Nothing else changes `p2.main`.
		self.onLive(async (ctx) => {
			const durable = harness().durable;
			await fillLabels(durable, ctx);
			await reportTree(durable, ctx);
		});
	});

	host.serve(
		SessionTree,
		(_params, principal, self) => {
			if (!isOwner(principal)) throw forbidden("the tree is the owner's");
			const harness = harnessOf(self);
			const worker = workerOf(self);
			return {
				variant: "owner",
				members: {
					tree: (ctx) => worker().liveness.call(() => readTree(harness().durable, ctx)),
					navigate: ({ entry }, ctx) =>
						worker().liveness.call(async () => {
							const durable = harness().durable;
							const switched = await navigate(durable, entry as EntryId, ctx);
							await reportTree(durable, ctx);
							return switched;
						}),
					select: ({ conversation }, ctx) =>
						worker().liveness.call(async () => {
							const durable = harness().durable;
							await select(durable, conversation as ConversationId, ctx);
							await reportTree(durable, ctx);
							return null;
						}),
					branch: ({ conversation, label }, ctx) =>
						worker().liveness.call(async () => {
							const durable = harness().durable;
							const fork = await branch(durable, conversation as ConversationId, label, ctx);
							await reportTree(durable, ctx);
							return { conversation: fork };
						}),
					rename: ({ conversation, label }, ctx) =>
						worker().liveness.call(async () => {
							const durable = harness().durable;
							await rename(durable, conversation, label, ctx);
							await reportTree(durable, ctx);
							return null;
						}),
				},
			};
		},
		{ accepts: TREE_ACCEPTS },
	);
});

/**
 * Tells the catalog the current main conversation and the branches, newest first, each with the conversation it was
 * forked from: its Durable record's parent (records are table reads, one commit per report; reports are rare: at start
 * and per change of `p2.main`). The catalog ignores an unchanged report.
 */
async function reportTree(durable: Harness, ctx: Ctx): Promise<void> {
	const state = await durable.snapshot(MainDoc, ctx);
	const main = state?.conversation ?? ROOT_CONVERSATION_ID;
	const parents = new Map(
		(await topLevelRecords(durable, ctx)).flatMap((record): [number, number][] =>
			record.parent ? [[record.id, record.parent.conversationId]] : [],
		),
	);
	const branches: Branch[] = (state?.branches ?? [{ conversation: ROOT_CONVERSATION_ID, label: null }])
		.map(({ conversation, label }) => {
			const parent = parents.get(conversation);
			return parent === undefined ? { conversation, label } : { conversation, label, parent };
		})
		.toReversed();
	await expectVariant(await ctx.get(Sessions, {}), "worker").treeSelf({ main, branches }, ctx);
}

/**
 * Labels the branches `p2.main` version 1 listed without one (conversation 1 keeps null, the session title): the
 * fork point's message, else the branch's first own user message. Runs at start; a branch `/tree` creates is labelled
 * in the commit that creates it, so nothing is derived after this.
 */
async function fillLabels(durable: Harness, context: Context): Promise<void> {
	const state = await durable.snapshot(MainDoc, context);
	const unlabeled = new Set(
		(state?.branches ?? []).flatMap((branch) =>
			branch.label === null && branch.conversation !== ROOT_CONVERSATION_ID ? [branch.conversation] : [],
		),
	);
	if (unlabeled.size === 0) return;
	const labels = new Map<number, string>();
	for (const record of await topLevelRecords(durable, context)) {
		if (!unlabeled.has(record.id)) continue;
		const label = await forkLabel(durable, record, context);
		if (label !== undefined) labels.set(record.id, label);
	}
	if (labels.size === 0) return;
	await durable.commit(async (tx) => {
		for (const branch of (await tx.doc(MainDoc)).branches)
			if (branch.label === null) branch.label = labels.get(branch.conversation) ?? null;
	}, context);
}

/** A version 1 branch's label: its fork point's message, else its first own user message; undefined without either. */
async function forkLabel(durable: Harness, record: ConversationRecord, context: Context): Promise<string | undefined> {
	const parent = record.parent;
	const point = parent ? await durable.commit((tx) => tx.entry(parent.at as EntryId), context) : undefined;
	const atPoint = point ? previewOf(point)?.text : undefined;
	if (atPoint !== undefined) return atPoint;
	const conversation = await durable.conversation(record.id, context);
	if (!conversation) return undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries(
			{ minEntryId: ((parent?.at ?? 0) + 1) as EntryId, order: "ascending" },
			PAGE,
			cursor,
			context,
		);
		const user = page.items.map(previewOf).find((preview) => preview?.role === "user");
		if (user) return user.text;
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

/** Entries per page when walking a conversation. */
const PAGE = 500;

/** The messages of every top-level conversation, each hung below the node its branch continues from. */
async function readTree(durable: Harness, context: Context): Promise<Tree> {
	const records = await topLevelRecords(durable, context);
	const parents = new Map(records.map((record) => [record.id, record.parent]));
	/** Each conversation's own nodes (entries after its fork point), in order. */
	const own = new Map<ConversationId, TreeNode[]>();
	/** The last node at or before `at` on `id`'s line: its own nodes, then its parent's up to the fork point. */
	const lastOn = (id: ConversationId, at: number): number | null => {
		const found = (own.get(id) ?? []).findLast((node) => node.entry <= at);
		if (found) return found.entry;
		const parent = parents.get(id);
		return parent ? lastOn(parent.conversationId, Math.min(at, parent.at)) : null;
	};
	// Ascending IDs: a fork is created after its parent, so the parent's nodes are known first.
	for (const record of records) {
		const conversation = await durable.conversation(record.id, context);
		if (!conversation) continue;
		const nodes: TreeNode[] = [];
		let previous = record.parent ? lastOn(record.parent.conversationId, record.parent.at) : null;
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries(
				{ minEntryId: ((record.parent?.at ?? 0) + 1) as EntryId, order: "ascending" },
				PAGE,
				cursor,
				context,
			);
			for (const entry of page.items) {
				const preview = previewOf(entry);
				if (!preview) continue;
				nodes.push({ entry: entry.id, parent: previous, conversation: record.id, ...preview });
				previous = entry.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		own.set(record.id, nodes);
	}
	const state = await durable.snapshot(MainDoc, context);
	const main = (state?.conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
	return {
		nodes: [...own.values()].flat().sort((a, b) => a.entry - b.entry),
		branches: state?.branches ?? [{ conversation: ROOT_CONVERSATION_ID, label: null }],
		main,
		current: lastOn(main, Number.MAX_SAFE_INTEGER),
	};
}

/**
 * A user message's or an assistant answer's text on one line, at most `PREVIEW_LENGTH` characters (a tree node, a
 * branch label); undefined for every other entry and for messages without text.
 */
function previewOf(entry: EntryRecord): Pick<TreeNode, "role" | "text"> | undefined {
	const role = roleOf(entry);
	if (!role) return undefined;
	const text = oneLine(role === "user" ? userText(entry) : assistantText(entry));
	return text ? { role, text } : undefined;
}

/** Text on one line, trimmed, at most `PREVIEW_LENGTH` characters. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH);
}

function roleOf(entry: EntryRecord): TreeNode["role"] | undefined {
	const message = entry.model?.[0];
	if (entry.kind === "pi.assistant") return "assistant";
	// Head markers (resets, compaction summaries) carry user messages that no one typed.
	return message?.role === "user" && entry.head === undefined ? "user" : undefined;
}

/** What a person, a peer session or a subagent wrote (structured input data), else the user message's text. */
function userText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	const content = message?.role === "user" ? message.content : "";
	return (
		messageData(entry.data)?.text ??
		peerMessage(entry.kind, entry.data)?.text ??
		agentMessage(entry.kind, entry.data)?.text ??
		(typeof content === "string"
			? content
			: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
	);
}

function assistantText(entry: EntryRecord): string {
	const message = entry.model?.[0] as AssistantMessage | undefined;
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/**
 * Switches the main conversation so the session continues at `entry`: after an answer, before a user message (whose
 * text comes back). A top-level conversation already ending there is reused, its label unchanged; else a fork of the
 * conversation storing the point, or a new empty conversation before the first message, labelled with the chosen
 * message (what the owner picked: the answer, or the user message typed again). The new conversation, its label, the
 * carried documents and the main pointer are one commit. A run of the conversation left keeps going in the background,
 * read-only.
 */
async function navigate(
	durable: Harness,
	entry: EntryId,
	context: Context,
): Promise<{ conversation: number; text: string | null }> {
	const main = await mainConversation(durable, context);
	const chosen = await durable.commit((tx) => tx.entry(entry), context);
	if (!chosen || !(await isTopLevel(durable, chosen.conversationId, context))) throw new Error("Unknown message");
	const role = roleOf(chosen);
	if (!role) throw new Error("Only messages can be chosen");
	const storing = await durable.conversation(chosen.conversationId, context);
	if (!storing) throw new Error("Unknown message");
	// A user message is typed again: the session continues before it.
	const point =
		role === "user"
			? (await storing.entries({ maxEntryId: (entry - 1) as EntryId }, 1, undefined, context)).items[0]
			: chosen;
	const text = role === "user" ? userText(chosen) : null;
	const target = await branchEndingAt(durable, main, point?.id, context);
	if (target === main) return { conversation: main, text };
	// Before the first message: a new conversation with the agent as it was then (a fork needs an entry to start at).
	const agent =
		target === undefined && point === undefined
			? ((await durable.snapshotAsOf(AgentDoc, chosen.conversationId, entry, context)) ?? {})
			: undefined;
	const conversation = await durable.commit(async (tx) => {
		let to = target;
		if (to === undefined && point) to = (await tx.forkConversation(point.conversationId, point.id, OWNERLESS)).id;
		else if (to === undefined) {
			to = (await tx.createConversation(OWNERLESS)).id;
			Object.assign(await tx.doc(AgentDoc, to), JSON.parse(JSON.stringify(agent)) as JsonObject);
		}
		const state = await tx.doc(MainDoc);
		state.conversation = to;
		if (!state.branches.some((branch) => branch.conversation === to))
			state.branches.push({ conversation: to, label: previewOf(chosen)?.text ?? null });
		return to;
	}, context);
	return { conversation, text };
}

const OWNERLESS = { ownership: { kind: "ownerless" } } as const;

/**
 * Forks the top-level conversation `id` at its last entry and makes the fork the main conversation, labelled `label`
 * (one line, at most `PREVIEW_LENGTH` characters): the next message starts a new branch, and `id` keeps ending where
 * it did. The fork, its label and the main pointer are one commit.
 */
async function branch(durable: Harness, id: ConversationId, label: string, context: Context): Promise<ConversationId> {
	// Schema-checked arguments: the label's one-line rule is this method's own.
	const text = oneLine(label);
	if (!text) throw new Error("A branch label needs at least one character");
	if (!(await isTopLevel(durable, id, context))) throw new Error("Unknown branch");
	const tail = (await (await durable.conversation(id, context))?.entries({}, 1, undefined, context))?.items[0];
	if (!tail) throw new Error("Nothing to branch from yet: the conversation has no messages");
	return durable.commit(async (tx) => {
		// Forked from the conversation storing the entry: the same history, a shorter chain (as `navigate`).
		const fork = (await tx.forkConversation(tail.conversationId, tail.id, OWNERLESS)).id;
		const state = await tx.doc(MainDoc);
		state.conversation = fork;
		state.branches.push({ conversation: fork, label: text });
		return fork;
	}, context);
}

/** Switches the main conversation to the top-level conversation `id` (its latest message); a run there goes on. */
async function select(durable: Harness, id: ConversationId, context: Context): Promise<void> {
	if (!(await isTopLevel(durable, id, context))) throw new Error("Unknown branch");
	if (id === (await mainConversation(durable, context))) return;
	await durable.commit(async (tx) => {
		(await tx.doc(MainDoc)).conversation = id;
	}, context);
}

/**
 * Labels the branch `id`: one line, 1 to `PREVIEW_LENGTH` characters. Null or empty resets conversation 1 to the
 * session title; another branch needs a label (it has a fork point to be named after).
 */
async function rename(durable: Harness, id: number, label: string | null, context: Context): Promise<void> {
	// Schema-checked arguments: the length and the null rule are this method's own.
	const text = (label ?? "").replace(/\s+/g, " ").trim();
	if (text.length > PREVIEW_LENGTH) throw new Error(`A branch label has at most ${PREVIEW_LENGTH} characters`);
	if (!text && id !== ROOT_CONVERSATION_ID) throw new Error("A branch label needs at least one character");
	await durable.commit(async (tx) => {
		const branch = (await tx.doc(MainDoc)).branches.find((each) => each.conversation === id);
		if (!branch) throw new Error("Unknown branch");
		branch.label = text || null;
	}, context);
}

/** A top-level conversation whose history ends at `point` (none: has no entries), the main conversation first. */
async function branchEndingAt(
	durable: Harness,
	main: ConversationId,
	point: EntryId | undefined,
	context: Context,
): Promise<ConversationId | undefined> {
	const branches = await topLevelConversations(durable, context);
	for (const id of [main, ...branches.filter((id) => id !== main)]) {
		const tail = (await (await durable.conversation(id, context))?.entries({}, 1, undefined, context))?.items[0];
		if (tail?.id === point) return id;
	}
	return undefined;
}
