// Feeds the top-level conversations' (the main conversation and its `/tree` branches) and subagents' messages into the
// server index with per-conversation acknowledged catch-up.
import { setTimeout as sleep } from "node:timers/promises";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	type Cursor,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { bool } from "@earendil-works/pi-schema";
import {
	type Ctx,
	defineFacet,
	forbidden,
	isChordError,
	local,
	messageData,
	peerMessage,
	SHELL_ENTRY,
	signalOf,
	until,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { CommitSignal, harnessOf, topLevelRecords } from "@p2/app/v1/worker";
import { Subagents } from "../subagents/contract.worker.ts";
import { type IndexedMessage, IndexScan, SearchFeed } from "./contract.ts";

const Indexer = local("p2.search-indexer", {
	version: 1,
	params: {},
	/** The first full scan since this worker started has committed (an index rebuild waits for it). */
	members: { scanned: bool() },
});

const PAGE = 200;

/**
 * What an input or answer said: a person's or a peer session's input by its data (what they typed, not a mention's
 * digest), a tool's input and an answer by their text.
 */
function indexedMessage(entry: EntryRecord): IndexedMessage | undefined {
	const role = entry.model?.[0]?.role;
	if (role !== "user" && role !== "assistant") return undefined;
	// Durable's own entries with user messages (compaction summaries, handoffs) are not inputs; neither are user shell
	// commands (`!cmd`), whose model message is the command's output (it must not become the session's title).
	if (role === "user" && entry.kind.startsWith("pi.") && entry.kind !== "pi.user") return undefined;
	if (entry.kind === SHELL_ENTRY) return undefined;
	if (role === "assistant" && !AssistantEntry.is(entry)) return undefined;
	const messages = entry.model?.filter((message) => message.role === role) ?? [];
	const typed =
		role === "user" ? (messageData(entry.data)?.text ?? peerMessage(entry.kind, entry.data)?.text) : undefined;
	const text =
		typed ??
		messages
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
			)
			.join("\n");
	if (!text.trim()) return undefined;
	return {
		conversationId: entry.conversationId,
		entryId: entry.id,
		role,
		timestamp: messages[0]?.timestamp ?? 0,
		text,
	};
}

/**
 * Sends a conversation's entries after `through` up to the newest, a page at a time; each call returns once
 * the server committed it. The cursor sent with a page stays `through` until the last page, so an interruption
 * makes the next scan start over the same range (indexing is idempotent by entry ID). Returns the new cursor.
 */
async function catchUp(
	root: Conversation,
	feed: {
		index(batch: { conversation: number; messages: IndexedMessage[]; through: number }, ctx: Ctx): Promise<unknown>;
	},
	through: number,
	ctx: Ctx,
): Promise<number> {
	const context = durableContext(ctx);
	const upper = (await root.entries({}, 1, undefined, context)).items[0]?.id;
	if (upper === undefined || upper <= through) return through;
	let cursor: Cursor | undefined;
	do {
		const page = await root.entries(
			{ minEntryId: (through + 1) as EntryId, maxEntryId: upper },
			PAGE,
			cursor,
			context,
		);
		cursor = page.next;
		const messages = page.items.map(indexedMessage).filter((message) => message !== undefined);
		await feed.index({ conversation: root.id, messages, through: cursor === undefined ? upper : through }, ctx);
	} while (cursor !== undefined);
	return upper;
}

export default defineFacet((host) => {
	host.serve(Indexer, (_params, self) => {
		const harness = harnessOf(self);
		const feed = self.get(SearchFeed, {});
		const scanned = self.writable(false);
		const commits = self.open(
			async () =>
				new CommitSignal(harness().durable, (publication) =>
					publication.changes.some(
						(change) =>
							change.type === "entry" ||
							(change.type === "document" && change.record.kind === Subagents.definition.kind),
					),
				),
			(signal) => signal.close(),
		);
		// A watch is not an audit log: scan immutable history at start and after every entry commit, so
		// overflow, resets, compaction and crashes cannot lose entries.
		self.onLive(async (ctx) => {
			const durable = harness().durable;
			const signal = commits.value;
			// Ends quietly when the task is stopped (shutdown, reload).
			const pause = (wait: Promise<unknown>): Promise<boolean> =>
				wait.then(
					() => true,
					() => false,
				);
			while (!signalOf(ctx).aborted) {
				const seen = signal.version;
				try {
					const context = durableContext(ctx);
					const registry = await durable.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
					// A branch's history starts after its fork point: what it inherits is indexed with the conversation
					// storing it.
					const starts = new Map<number, number>(
						(await topLevelRecords(durable, context)).map((record) => [record.id, record.parent?.at ?? 0]),
					);
					for (const agent of Object.values(registry?.agents ?? {})) starts.set(agent.conversationId, 0);
					for (const [id, start] of starts) {
						const conversation = await durable.conversation(id as ConversationId, context);
						if (!conversation) continue;
						const through = await feed.cursor({ conversation: id }, ctx);
						await catchUp(conversation, feed, Math.max(through, start), ctx);
					}
					scanned.set(true);
				} catch (error) {
					if (signalOf(ctx).aborted) return;
					// The server was unreachable or reloading: ask for its cursor again and retry the range.
					if (!isChordError(error) || error.code !== "unavailable")
						console.error("p2 search: indexing failed, retrying:", error);
					await pause(sleep(1000, undefined, { signal: signalOf(ctx) }));
					continue;
				}
				await pause(signal.next(seen, signalOf(ctx)));
			}
		});
		return { scanned: self.derive([scanned], ([value]) => value) };
	});

	host.serve(IndexScan, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const indexer = self.get(Indexer, {});
		return {
			variant: "server",
			members: {
				scanned: async (ctx) => {
					await until(indexer.scanned, (done) => done, ctx);
					return null;
				},
			},
		};
	});
});
