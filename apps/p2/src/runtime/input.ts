// People's messages as Durable entry data (browser-safe). Every input a person sends is placed as its own entry kind
// (`p2.input`; chat-mode's `chat.mention`) whose data says who wrote what. Display-only entries (chat-mode's
// `chat.message`) carry the same data. The model message of an input starts with the sender block (`sender.ts`), which
// nothing reads back: readers use the data.

import { arr, compile, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal } from "./schema.ts";

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
