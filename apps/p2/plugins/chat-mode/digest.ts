// What the agent receives when someone mentions it in chat mode, and what a reply quotes (pure functions, worker and
// tests). Everything here reads entry data; nothing parses text written for the model.
import type { EntryRecord, InboxState } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import type { Author } from "@p2/app/v1";
import { messageOf } from "@p2/app/v1";
import type { Submit } from "../chat/contract.ts";
import type { Attachment } from "../files/contract.ts";
import {
	CHAT_ENTRY,
	type ChatMessage,
	chatMessage,
	MENTION_ENTRY,
	type Mention,
	mention,
	type ReplyTo,
	ReplyToSchema,
} from "./contract.ts";

/** At most this many chat messages go into one mention; older ones are counted, not quoted. */
export const MAX_DIGEST_MESSAGES = 100;
/** At most this many of their attachments are listed (the newest). */
export const MAX_DIGEST_FILES = 20;
/** Inline at most this many images per mention, the newest; the rest are listed by path. */
export const MAX_DIGEST_IMAGES = 4;

/** At most this many characters of a replied-to message are quoted, whitespace collapsed. */
export const EXCERPT_LENGTH = 60;

const isReplyTo = compile(ReplyToSchema).check;

/** How a digest names a message's author: `Ann (guest, replying to Bob: "should we split…")`. */
function speaker(author: Author, replyTo?: ReplyTo): string {
	const notes = [
		...(author.kind === "guest" ? ["guest"] : []),
		...(replyTo ? [`replying to ${replyTo.author.name}: "${replyTo.excerpt}"`] : []),
	];
	return notes.length ? `${author.name} (${notes.join(", ")})` : author.name;
}

/** The start of a message: whitespace collapsed, cut at EXCERPT_LENGTH characters with an ellipsis. */
export function excerpt(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : flat;
}

const AGENT = { kind: "agent", id: "agent", name: "Pi" } as const;

/**
 * What a reply quotes from an entry, derived from the entry's own data: a chat message, a person's input (for a
 * mention, what they wrote, not the digest), or one of Pi's answers. Undefined for anything else.
 */
export function quoteOf(entry: EntryRecord): ReplyTo | undefined {
	const quote = (author: ReplyTo["author"], text: string): ReplyTo | undefined => {
		const result = { entryId: entry.id, author, excerpt: excerpt(text) };
		return isReplyTo(result) ? result : undefined;
	};
	const message = entry.model?.[0];
	if (message?.role === "assistant")
		return quote(AGENT, message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" "));
	const person = messageOf(entry.data, entry.kind === "pi.user" && message ? message.content : undefined);
	return person && quote(person.author, person.text);
}

/** A chat entry: its ID (what a mention records) and its message. */
export type ChatEntry = { readonly id: number; readonly message: ChatMessage };

/**
 * Where a scan may stop: the lowest chat entry the latest placed mention passed on. Its digest took every chat message
 * not yet passed on, so older ones were passed on before, or dropped by the digest's cap. A mention that passed on
 * nothing bounds nothing: chat placed while it waited lies below it.
 */
const boundaryOf = (entries: readonly EntryRecord[]): number | undefined => {
	for (const entry of entries) {
		const data = entry.kind === MENTION_ENTRY ? mention(entry.data) : undefined;
		if (data?.included.length) return Math.min(...data.included);
	}
	return undefined;
};

/** Whether a newest-first read has gone far enough for `unmentioned` (the reader may stop). */
export const readEnough = (entries: readonly EntryRecord[]): boolean => {
	const boundary = boundaryOf(entries);
	return boundary !== undefined && (entries.at(-1)?.id ?? 0) <= boundary;
};

/**
 * Chat messages no mention has passed on to Pi yet, oldest first. `entries` are newest first, as a backwards scan
 * reads them; `inbox` holds mentions still queued. Each mention records the chat entries its digest included, so a chat
 * message placed while a mention waited in the queue is not covered by it and goes with the next one. The scan stops
 * at the lowest chat entry the latest mention passed on (see `boundaryOf`).
 */
export function unmentioned(entries: readonly EntryRecord[], inbox?: InboxState): ChatEntry[] {
	const covered = new Set<number>();
	for (const item of inbox?.items ?? []) {
		const queued = item.mode !== "write" && item.entry?.kind === MENTION_ENTRY ? mention(item.entry.data) : undefined;
		for (const id of queued?.included ?? []) covered.add(id);
	}
	const boundary = boundaryOf(entries) ?? Number.NEGATIVE_INFINITY;
	const found: ChatEntry[] = [];
	for (const entry of entries) {
		if (entry.id < boundary) break;
		const earlier = entry.kind === MENTION_ENTRY ? mention(entry.data) : undefined;
		for (const id of earlier?.included ?? []) covered.add(id);
		const message = entry.kind === CHAT_ENTRY ? chatMessage(entry.data) : undefined;
		if (message && !covered.has(entry.id)) found.push({ id: entry.id, message });
	}
	return found.reverse();
}

/** The mention's text for the model: the chat not passed on yet, with its authors, then who asks and what. */
export function digest(chat: readonly ChatEntry[], author: Author, text: string, answering?: ReplyTo): string {
	const quoted = chat.slice(-MAX_DIGEST_MESSAGES);
	const omitted = chat.length - quoted.length;
	const lines = quoted.map(({ message }) => {
		const files = message.attachments.length
			? ` [attached: ${message.attachments.map((file) => file.name).join(", ")}]`
			: "";
		return `${speaker(message.author, message.replyTo)}: ${message.text}${files}`;
	});
	const header = chat.length
		? [
				"<chat>",
				"Since you were last mentioned, people in this session talked to each other. They did not address you:",
				...(omitted ? [`(${omitted} earlier messages omitted)`] : []),
				...lines,
				"</chat>",
				"",
			]
		: [];
	return [...header, `${speaker(author, answering)} mentioned you:`, text].join("\n");
}

/** Upload IDs to resolve for a mention: the chat's newest attachments, then the asker's own. */
export const digestFiles = (chat: readonly ChatEntry[], own: readonly string[]): string[] => [
	...chat
		.flatMap(({ message }) => message.attachments.map((file) => file.id))
		.slice(-MAX_DIGEST_FILES)
		.filter((id) => !own.includes(id)),
	...own,
];

/**
 * A mention as the chat plugin submits it: the one place that decides what a mention is. It is placed as a
 * `chat.mention` entry whose data is what the person wrote (author, text, attachments, reply) and the chat entries
 * passed on; the model reads the digest, which the chat plugin starts with the author's speaker block.
 */
export function composeMention(input: {
	readonly author: Author;
	readonly text: string;
	readonly chat: readonly ChatEntry[];
	readonly replyTo?: ReplyTo;
	readonly attachments: readonly { readonly id: string; readonly name: string }[];
	readonly files: readonly Attachment[];
	readonly requestId: string;
	readonly whenBusy?: "steer" | "followUp";
}): Submit {
	const data: Mention = {
		author: input.author,
		text: input.text,
		attachments: input.attachments.map(({ id, name }) => ({ id, name })),
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		included: input.chat.slice(-MAX_DIGEST_MESSAGES).map((entry) => entry.id),
	};
	return {
		text: digest(input.chat, input.author, input.text, input.replyTo),
		requestId: input.requestId,
		...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
		author: input.author,
		files: [...input.files],
		maxImages: MAX_DIGEST_IMAGES,
		entry: { kind: MENTION_ENTRY, data },
	};
}
