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
	type InboxState,
} from "@earendil-works/pi-durable";
import { num, obj } from "@earendil-works/pi-schema";
import {
	type Context,
	type Ctx,
	canView,
	contribute,
	defineFacet,
	defineState,
	deriveTyped,
	forbidden,
	invalid,
	isOwner,
} from "@p2/app/v1";
import { agentConversation, harnessOf } from "@p2/app/v1/worker";
import { Conversation, SendRouters } from "../chat/contract.ts";
import { Attachments, MAX_ATTACHMENTS } from "../files/contract.ts";
import {
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
	const conversation = await durable.conversation(id, ctx);
	const entries: EntryRecord[] = [];
	let before = Number.MAX_SAFE_INTEGER;
	while (conversation && entries.length < limit && !readEnough(entries)) {
		const page = await conversation.entries({ maxEntryId: (before - 1) as EntryId }, 256, undefined, ctx);
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
	const conversation = await durable.conversation(id, ctx);
	const only = { minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId };
	const page = await conversation?.entries(only, 1, undefined, ctx);
	const entry = page?.items[0];
	const quote: ReplyTo | undefined = entry?.id === entryId ? quoteOf(entry) : undefined;
	if (!quote) throw invalid("args", "That message cannot be replied to");
	return quote;
}

/** How many chat messages a mention would pass on now: computed from the transcript, which the view only windows. */
const Waiting = defineState("p2.chat-mode-setting.waiting", {
	schema: obj({ count: num() }),
	version: 1,
	initial: () => ({ count: 0 }),
});

export default defineFacet((host) => {
	host.serve(
		ChatModeSetting,
		({ conversation }, self) => {
			const id = conversation as ConversationId;
			const harness = harnessOf(self);
			// The conversation's view (shared with its viewers): its entries and queue change what waits for a mention.
			const chat = self.get(Conversation, { conversation });
			/** Where the agent's chat mode is (the main agent's on conversation 1); found when the document is followed. */
			let holder = id;
			const settings = self.follow(async (observer, ctx) => {
				const durable = harness().durable;
				holder = await agentConversation(durable, id, ctx);
				const observed = await durable.observeDoc(ChatModeDoc, holder, observer, ctx);
				if (observed !== undefined) return observed;
				// Nobody switched it yet: the document is absent, and an absent address cannot be followed. Create it as it
				// reads (off, the default name).
				await durable.commit(async (tx) => {
					await tx.doc(ChatModeDoc, holder);
				}, ctx);
				return durable.observeDoc(ChatModeDoc, holder, observer, ctx);
			});
			const waiting = self.state(Waiting);
			const counted = deriveTyped(self, [settings, chat.view], ([doc, view]) => ({
				enabled: doc.enabled,
				newest: view?.entries.at(-1)?.id ?? 0,
				inbox: (view?.docs[InboxDoc.definition.kind] ?? null) as InboxState | null,
			}));
			// The view holds only a window of the entries: the router's backwards scan counts what waits.
			self.on(counted, async ({ value }, ctx) => {
				const count = value.enabled
					? unmentioned(await recentEntries(harness().durable, id, ctx), value.inbox ?? undefined).length
					: 0;
				if (waiting.value.count !== count)
					await waiting.change((draft) => {
						draft.count = count;
					}, ctx);
			});
			const commit = async (ctx: Ctx, change: (doc: { enabled: boolean; name: string }) => void) => {
				const durable = await harness().durable.conversation(id, ctx);
				if (!durable) throw invalid("args", `Unknown conversation ${conversation}`);
				await durable.commit(async (tx) => change(await tx.doc(ChatModeDoc, holder)), ctx);
			};
			return {
				enabled: self.derive([settings], ([doc]) => doc.enabled),
				name: self.derive([settings], ([doc]) => doc.name),
				waiting: self.derive([waiting], ([value]) => value.count),
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
				const settings = await durable.snapshot(ChatModeDoc, await agentConversation(durable, id, ctx), ctx);
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
				const inbox = await durable.snapshot(InboxDoc, id, ctx);
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
