// Chat mode (worker): the per-conversation switch and the agent's name (what people mention, `@pi` by default), kept
// in a Durable document; the router that turns messages into chat entries or mentions; and the view each browser
// holds.

import {
	type ConversationId,
	type Harness as DurableHarness,
	defineDoc,
	type EntryId,
	type EntryRecord,
	InboxDoc,
} from "@earendil-works/pi-durable";
import { bool, num, obj } from "@earendil-works/pi-schema";
import {
	type Context,
	type Ctx,
	canView,
	contribute,
	defineFacet,
	defineState,
	forbidden,
	invalid,
	isOwner,
	signalOf,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { agentConversation, CommitSignal, harnessOf } from "@p2/app/v1/worker";
import { Conversation, SendRouters } from "../chat/contract.ts";
import { Attachments, MAX_ATTACHMENTS } from "../files/contract.ts";
import {
	AgentNameSchema,
	CHAT_ENTRY,
	type ChatMessage,
	ChatMode,
	ChatModeSetting,
	DEFAULT_AGENT_NAME,
	mentionsAgent,
	type ReplyTo,
} from "./contract.ts";
import { composeMention, digestFiles, quoteOf, readEnough, unmentioned } from "./digest.ts";

/**
 * The switch and the agent's name, stored per agent (`agentConversation`: the main agent's on conversation 1, whichever
 * `/tree` branch it works in; a new subagent starts with chat mode off and the default name).
 */
export const ChatModeDoc = defineDoc<{ enabled: boolean; name: string }>({
	kind: "chat-mode.settings",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ enabled: false, name: DEFAULT_AGENT_NAME }),
	checkpointWhen: () => true,
	// Version 1 had the switch only.
	migrate: (value) => ({ enabled: value.enabled === true, name: DEFAULT_AGENT_NAME }),
});

/** A conversation's newest entries, newest first, until `unmentioned` has what it needs (at most `limit`). */
async function recentEntries(durable: DurableHarness, id: ConversationId, ctx: Context, limit = 2000) {
	const conversation = await durable.conversation(id, durableContext(ctx));
	const entries: EntryRecord[] = [];
	let before = Number.MAX_SAFE_INTEGER;
	while (conversation && entries.length < limit && !readEnough(entries)) {
		const page = await conversation.entries(
			{ maxEntryId: (before - 1) as EntryId },
			256,
			undefined,
			durableContext(ctx),
		);
		for (const entry of page.items) {
			entries.push(entry);
			before = entry.id;
		}
		if (page.next === undefined) break;
	}
	return entries;
}

/**
 * What a reply quotes, read from the entry itself. Only an entry of this conversation qualifies: Durable lists a
 * conversation's own entries, so an ID from another conversation is not found.
 */
export async function replyTarget(durable: DurableHarness, id: ConversationId, entryId: number, ctx: Context) {
	const conversation = await durable.conversation(id, durableContext(ctx));
	const only = { minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId };
	const page = await conversation?.entries(only, 1, undefined, durableContext(ctx));
	const entry = page?.items[0];
	const quote: ReplyTo | undefined = entry?.id === entryId ? quoteOf(entry) : undefined;
	if (!quote) throw invalid("args", "That message cannot be replied to");
	return quote;
}

/** What the cells show of the document, and how many messages wait for a mention. */
const Shown = defineState("p2.chat-mode-setting", {
	schema: obj({ enabled: bool(), name: AgentNameSchema, waiting: num() }),
	version: 1,
	initial: () => ({ enabled: false, name: DEFAULT_AGENT_NAME, waiting: 0 }),
});

export default defineFacet((host) => {
	host.serve(
		ChatModeSetting,
		({ conversation }, self) => {
			const id = conversation as ConversationId;
			const harness = harnessOf(self);
			/** Where the agent's chat mode is (the main agent's on conversation 1); set when the object opens. */
			let holder = id;
			const read = async (ctx: Context) =>
				(await harness().durable.snapshot(ChatModeDoc, holder, durableContext(ctx))) ?? {
					enabled: false,
					name: DEFAULT_AGENT_NAME,
				};
			const shown = self.state(Shown);
			const commits = self.open(
				async (ctx) => {
					const durable = harness().durable;
					holder = await agentConversation(durable, id, durableContext(ctx));
					const doc = await read(ctx);
					await shown.change((draft) => {
						draft.enabled = doc.enabled;
						draft.name = doc.name;
					}, ctx);
					if (!(await durable.conversation(id, ctx))) throw new Error(`Unknown conversation ${conversation}`);
					// The waiting count also follows the entries and the queue.
					return new CommitSignal(durable, (publication) =>
						publication.changes.some(
							(change) =>
								(change.type === "entry" && change.value.conversationId === id) ||
								(change.type === "document" &&
									change.record.kind === ChatModeDoc.definition.kind &&
									change.conversationId === holder) ||
								(change.type === "document" &&
									change.record.kind === InboxDoc.definition.kind &&
									change.conversationId === id),
						),
					);
				},
				(signal) => signal.close(),
			);
			// The document is the truth; the cells show it. Subscribed before reading, so no commit is missed. The view
			// holds only a window of the entries, so the router's backwards scan counts what waits, while chat mode is on.
			self.onLive(async (ctx) => {
				const signal = signalOf(ctx);
				while (!signal.aborted) {
					const seen = commits.value.version;
					const doc = await read(ctx);
					const durable = harness().durable;
					const count = doc.enabled
						? unmentioned(
								await recentEntries(durable, id, ctx),
								await durable.snapshot(InboxDoc, id, durableContext(ctx)),
							).length
						: 0;
					const current = shown.value;
					if (current.enabled !== doc.enabled || current.name !== doc.name || current.waiting !== count)
						await shown.change((draft) => {
							draft.enabled = doc.enabled;
							draft.name = doc.name;
							draft.waiting = count;
						}, ctx);
					await commits.value.next(seen, signal).catch(() => {});
				}
			});
			const commit = async (ctx: Ctx, change: (doc: { enabled: boolean; name: string }) => void) => {
				const durable = await harness().durable.conversation(id, durableContext(ctx));
				if (!durable) throw invalid("args", `Unknown conversation ${conversation}`);
				await durable.commit(async (tx) => change(await tx.doc(ChatModeDoc, holder)), durableContext(ctx));
			};
			return {
				enabled: self.derive([shown], ([value]) => value.enabled),
				name: self.derive([shown], ([value]) => value.name),
				waiting: self.derive([shown], ([value]) => value.waiting),
				set: async ({ enabled: on }, ctx) => {
					await commit(ctx, (doc) => {
						doc.enabled = on;
					});
					return null;
				},
				rename: async ({ name: next }, ctx) => {
					await commit(ctx, (doc) => {
						doc.name = next;
					});
					return null;
				},
			};
		},
		{ linger: 30_000 },
	);

	contribute(host, "p2.chat-mode-router", (self) => {
		const harness = harnessOf(self);
		/** Validates upload IDs of this session (copying them to a remote environment, like any input's). */
		const resolve = async (ids: readonly string[], conversation: number, ctx: Ctx) => {
			const attachments = await ctx.get(Attachments, {});
			const files = [];
			for (let start = 0; start < ids.length; start += MAX_ATTACHMENTS)
				files.push(
					...(await attachments.resolve({ ids: ids.slice(start, start + MAX_ATTACHMENTS), conversation }, ctx)),
				);
			return files;
		};
		self.contribute(SendRouters, {
			"chat-mode": async ({ conversation, author, text, requestId, whenBusy, attachments, replyTo }, ctx) => {
				const durable = harness().durable;
				const id = conversation as ConversationId;
				const settings = await durable.snapshot(
					ChatModeDoc,
					await agentConversation(durable, id, durableContext(ctx)),
					durableContext(ctx),
				);
				if (!settings?.enabled) return undefined;
				const chat = await ctx.get(Conversation, { conversation });
				// The client names the entry; whom it quotes and what comes from the entry.
				const answering = replyTo === undefined ? undefined : await replyTarget(durable, id, replyTo, ctx);
				if (!mentionsAgent(text, settings.name ?? DEFAULT_AGENT_NAME)) {
					const files = await resolve(attachments, conversation, ctx);
					const data: ChatMessage = {
						author,
						text,
						attachments: files.map(({ id, name }) => ({ id, name })),
						...(answering ? { replyTo: answering } : {}),
					};
					return chat.write({ kind: CHAT_ENTRY, data, requestId, author }, ctx);
				}
				const inbox = await durable.snapshot(InboxDoc, id, durableContext(ctx));
				const earlier = unmentioned(await recentEntries(durable, id, ctx), inbox);
				const files = await resolve(digestFiles(earlier, attachments), conversation, ctx);
				const own = files.filter((file) => attachments.includes(file.id));
				const mention = {
					author,
					text,
					chat: earlier,
					replyTo: answering,
					attachments: own,
					files,
					requestId,
					whenBusy,
				};
				return chat.submit(composeMention(mention), ctx);
			},
		});
	});

	host.serve(ChatMode, ({ session, conversation }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const setting = self.get(ChatModeSetting, { conversation });
		if (!isOwner(principal))
			return {
				variant: "reader",
				members: { enabled: setting.enabled, waiting: setting.waiting, name: setting.name },
			};
		return {
			variant: "owner",
			members: {
				enabled: setting.enabled,
				waiting: setting.waiting,
				name: setting.name,
				set: (change, ctx) => setting.set(change, ctx),
				rename: (change, ctx) => setting.rename(change, ctx),
			},
		};
	});
});
