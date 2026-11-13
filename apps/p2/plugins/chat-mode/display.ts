// How chat entries add to the transcript's display of people's messages (the shared `TranscriptEntries` registry):
// a reply's quoted line and a mention's note. Pure; used by the web and the TUI facets.
import type { EntryDisplay } from "../chat/contract.ts";
import { CHAT_ENTRY, chatMessage, MENTION_ENTRY, mention, type ReplyTo } from "./contract.ts";

/** A reply's quoted line, from the quote the worker stored with it. */
const quoted = (replyTo: ReplyTo | undefined) =>
	replyTo && { replyTo: { entryId: replyTo.entryId, name: replyTo.author.name, excerpt: replyTo.excerpt } };
const plural = (count: number): string => (count === 1 ? "1 chat message" : `${count} chat messages`);

export const CHAT_ENTRY_DISPLAYS: Record<string, (data: unknown) => EntryDisplay | undefined> = {
	[CHAT_ENTRY]: (data) => quoted(chatMessage(data)?.replyTo),
	[MENTION_ENTRY]: (data) => {
		const asked = mention(data);
		const count = asked?.included.length ?? 0;
		return asked && { ...quoted(asked.replyTo), ...(count ? { note: `with ${plural(count)}` } : {}) };
	},
};
