// `/tree` in the session worker (`docs/tree.md`): the tree of the top-level conversations' messages, switching the
// current main conversation (forking a new branch where none ends at the chosen point), and the rules that come with
// it: older branches are read-only, and the session catalog follows the main conversation.
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
} from "@earendil-works/pi-durable";
import {
	type Context,
	type Ctx,
	contribute,
	defineFacet,
	expectVariant,
	forbidden,
	isOwner,
	messageOf,
	signalOf,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import {
	CommitSignal,
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

const NOT_CURRENT = "This is an earlier branch of the session: switch to it with /tree to continue it";

export default defineFacet((host) => {
	contribute(host, "p2.tree-branches", (self) => {
		const harness = harnessOf(self);
		// Only the current main conversation runs: an earlier branch shows its history but takes no input.
		self.contribute(ReadOnlyConversations, {
			tree: async (conversation, ctx) => {
				const durable = harness().durable;
				const context = durableContext(ctx);
				const id = conversation as ConversationId;
				return id !== (await mainConversation(durable, context)) && (await isTopLevel(durable, id, context))
					? NOT_CURRENT
					: undefined;
			},
		});
		// The catalog follows the main conversation and lists the branches: at start (also after a worker stopped between
		// a switch and its report), at every switch, and when a branch gets its first message (its label).
		/** Top-level conversations without a label yet: their first entry gives them one. */
		let unlabeled = new Set<number>();
		const commits = self.open(
			async () =>
				new CommitSignal(harness().durable, (publication) =>
					publication.changes.some(
						(change) =>
							(change.type === "document" && change.record.kind === MainDoc.definition.kind) ||
							(change.type === "entry" && unlabeled.has(change.value.conversationId)),
					),
				),
			(signal) => signal.close(),
		);
		self.onLive(async (ctx) => {
			const signal = signalOf(ctx);
			while (!signal.aborted) {
				const seen = commits.value.version;
				try {
					unlabeled = await reportTree(harness().durable, ctx);
				} catch (error) {
					if (signal.aborted) return;
					console.error("p2 tree: reporting the branches failed:", error);
				}
				await commits.value.next(seen, signal).catch(() => {});
			}
		});
	});

	host.serve(SessionTree, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("the tree is the owner's");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		return {
			variant: "owner",
			members: {
				tree: (ctx) => worker().liveness.call(() => readTree(harness().durable, durableContext(ctx))),
				navigate: ({ entry }, ctx) =>
					worker().liveness.call(async () => {
						const durable = harness().durable;
						const switched = await navigate(durable, entry as EntryId, durableContext(ctx));
						await reportTree(durable, ctx);
						return switched;
					}),
				select: ({ conversation }, ctx) =>
					worker().liveness.call(async () => {
						const durable = harness().durable;
						await select(durable, conversation as ConversationId, durableContext(ctx));
						await reportTree(durable, ctx);
						return null;
					}),
			},
		};
	});
});

/**
 * Tells the catalog the current main conversation and the branches (it ignores an unchanged report). Returns the
 * top-level conversations still without a label.
 */
async function reportTree(durable: Harness, ctx: Ctx): Promise<Set<number>> {
	const context = durableContext(ctx);
	const labels = labelsOf(durable);
	const branches: Branch[] = [];
	const unlabeled = new Set<number>();
	for (const record of await topLevelRecords(durable, context)) {
		let label = labels.get(record.id);
		if (label === undefined) {
			label = await labelOf(durable, record, context);
			if (label !== undefined) labels.set(record.id, label);
		}
		if (label !== undefined) branches.push({ conversation: record.id, label });
		else unlabeled.add(record.id);
	}
	await expectVariant(await ctx.get(Sessions, {}), "worker").treeSelf(
		{ main: await mainConversation(durable, context), branches: branches.reverse() },
		ctx,
	);
	return unlabeled;
}

/** Branch labels by conversation, per Harness: a branch's first own message never changes once it is there. */
const labels = new WeakMap<Harness, Map<number, string>>();

function labelsOf(durable: Harness): Map<number, string> {
	let known = labels.get(durable);
	if (!known) {
		known = new Map();
		labels.set(durable, known);
	}
	return known;
}

/** How many own entries a label looks at: a branch's first message comes early. */
const LABEL_SCAN = 100;

/** A branch's label: its first own user message, else its first own answer; undefined while it has no message. */
async function labelOf(durable: Harness, record: ConversationRecord, context: Context): Promise<string | undefined> {
	const conversation = await durable.conversation(record.id, context);
	if (!conversation) return undefined;
	const page = await conversation.entries(
		{ minEntryId: ((record.parent?.at ?? 0) + 1) as EntryId, order: "ascending" },
		LABEL_SCAN,
		undefined,
		context,
	);
	const nodes = page.items.flatMap((entry) => nodeOf(entry, null) ?? []);
	return (nodes.find((node) => node.role === "user") ?? nodes[0])?.text;
}

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
				500,
				cursor,
				context,
			);
			for (const entry of page.items) {
				const node = nodeOf(entry, previous);
				if (!node) continue;
				nodes.push(node);
				previous = node.entry;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		own.set(record.id, nodes);
	}
	const main = await mainConversation(durable, context);
	return {
		nodes: [...own.values()].flat().sort((a, b) => a.entry - b.entry),
		main,
		current: lastOn(main, Number.MAX_SAFE_INTEGER),
	};
}

/** A tree node for a user message or an assistant answer with text; undefined for every other entry. */
function nodeOf(entry: EntryRecord, parent: number | null): TreeNode | undefined {
	const role = roleOf(entry);
	if (!role) return undefined;
	const text = role === "user" ? userText(entry) : assistantText(entry);
	if (!text.trim()) return undefined;
	return { entry: entry.id, parent, role, text: text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH) };
}

function roleOf(entry: EntryRecord): TreeNode["role"] | undefined {
	const message = entry.model?.[0];
	if (entry.kind === "pi.assistant") return "assistant";
	// Head markers (resets, compaction summaries) carry user messages that no one typed.
	return message?.role === "user" && entry.head === undefined ? "user" : undefined;
}

/** What a person typed (structured input data), else the user message's text. */
function userText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	const content = message?.role === "user" ? message.content : "";
	return (
		messageOf(entry.data, content)?.text ??
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
 * text comes back). A top-level conversation already ending there is reused; else a fork of the conversation storing
 * the point, or a new empty conversation before the first message. The new conversation, the carried documents and
 * the main pointer are one commit.
 */
async function navigate(
	durable: Harness,
	entry: EntryId,
	context: Context,
): Promise<{ conversation: number; text: string | null }> {
	const main = await mainConversation(durable, context);
	await idleOrRefuse(durable, main, context);
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
		if (!state.branches.includes(to)) state.branches.push(to);
		return to;
	}, context);
	return { conversation, text };
}

const OWNERLESS = { ownership: { kind: "ownerless" } } as const;

/** Refuses a switch while the main conversation works: a run, queued input, or a task of its own. */
async function idleOrRefuse(durable: Harness, main: ConversationId, context: Context): Promise<void> {
	const inspection = await durable.inspect(context);
	if (
		inspection.tasks.some((task) => task.record.conversationId === main && !task.record.background) ||
		inspection.submissions.some((submission) => submission.conversationId === main)
	)
		throw new Error("Stop the current run before switching branches");
}

/** Switches the main conversation to the top-level conversation `id` (its latest message), refused while busy. */
async function select(durable: Harness, id: ConversationId, context: Context): Promise<void> {
	if (!(await isTopLevel(durable, id, context))) throw new Error("Unknown branch");
	const main = await mainConversation(durable, context);
	if (id === main) return;
	await idleOrRefuse(durable, main, context);
	await durable.commit(async (tx) => {
		(await tx.doc(MainDoc)).conversation = id;
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
