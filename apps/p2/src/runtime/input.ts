// People's messages as Durable entry data (browser-safe). Every input a person sends is placed as its own entry kind
// (`p2.input`; chat-mode's `chat.mention`) whose data says who wrote what. Display-only entries (chat-mode's
// `chat.message`) carry the same data. The model message of an input still starts with the speaker block, because the
// system prompt tells the model to attribute input by it, but nothing reads that block back: readers use the data.

import { arr, compile, obj, type Static, str, union } from "@earendil-works/pi-schema";
import type { Author } from "./principals.ts";
import { literal } from "./schema.ts";
import { SPEAKER_PREFIX } from "./speaker.ts";

/** Entry kind of a person's ordinary input. */
export const INPUT_ENTRY = "p2.input";

export const AuthorSchema = obj(
	{
		kind: union([literal("owner"), literal("guest")]),
		id: str(),
		name: str(),
	},
	{ open: true },
);

/** Who wrote a message, what they typed, and their attachments (upload IDs with file names). Kinds may add fields. */
export const MessageDataSchema = obj(
	{
		author: AuthorSchema,
		text: str(),
		attachments: arr(obj({ id: str(), name: str() }, { open: true })),
	},
	{ open: true },
);
export type MessageData = Static<typeof MessageDataSchema>;
const isMessageData = compile(MessageDataSchema).check;

/** The message data a server wrote for an input or display entry, if `data` is one. */
export const messageData = (data: unknown): MessageData | undefined => (isMessageData(data) ? data : undefined);

type Content = string | readonly { type: string; text?: string }[];

/**
 * A person's message from an entry (or a queued input): its data, or, for a `pi.user` entry or a queued input without
 * an entry from before structured inputs, the legacy speaker block. `legacy` is that content; pass it only then.
 */
export function messageOf(data: unknown, legacy?: Content): MessageData | undefined {
	const current = messageData(data);
	if (current) return current;
	const old = legacy === undefined ? undefined : legacyMessage(legacy);
	return old?.author ? { ...old, author: old.author } : undefined;
}

/** An old input as the legacy reader recovers it; inputs from before speaker blocks have no author. */
export type LegacyMessage = Omit<MessageData, "author"> & { author?: Author };

/**
 * LEGACY: sessions written before inputs carried structured entries (earendil-works/pi#10407) have `pi.user` entries
 * whose author is only in a leading `<mobile-speaker>` text block, with an `<attachments>` note appended to the text.
 * This is the only place that reads either back. Only the separate first block counts: a marker inside the text stays
 * ordinary text. Attachments come back as file names without upload IDs. Undefined when the content has neither (a
 * tool's input). Remove once old sessions no longer matter.
 */
export function legacyMessage(content: Content): LegacyMessage | undefined {
	// A plain string is all typed text: a speaker block in it establishes nothing.
	const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
	const [head, ...rest] = parts;
	let author: Author | undefined;
	if (
		typeof content !== "string" &&
		head?.type === "text" &&
		head.text?.startsWith(SPEAKER_PREFIX) &&
		head.text.endsWith("</mobile-speaker>")
	) {
		try {
			author = JSON.parse(head.text.slice(SPEAKER_PREFIX.length, -"</mobile-speaker>".length)) as Author;
		} catch {
			return undefined;
		}
	}
	const joined = (author ? rest : parts)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	const note = /(?:\n\n)?<attachments>\n[^\n]*\n([\s\S]*?)\n<\/attachments>$/.exec(joined);
	const attachments = (note?.[1] ?? "")
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ id: "", name: /\(([^,]+), \d+ bytes\)$/.exec(line)?.[1] ?? line.replace(/^- /, "") }));
	if (!author && !note) return undefined;
	const text = note ? joined.slice(0, note.index) : joined;
	if (!author) return { text, attachments };
	return messageData({ author, text, attachments });
}
