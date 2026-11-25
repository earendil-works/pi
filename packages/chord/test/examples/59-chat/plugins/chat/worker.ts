// The chat plugin on a channel's worker: the room's messages in a table of the worker's store (every message kept),
// written and read by one local object. The newest 100 are live through a live query (`self.query`: read before the
// object goes live, read again after every commit writing the table); older ones are read by page on request. Each
// principal's `Room` posts as them and shares files through the kit's `Files` of this worker.

import {
	Attachment,
	arr,
	defineFacet,
	defineTable,
	int,
	json,
	local,
	lt,
	Message,
	method,
	num,
	obj,
	opt,
	query,
	Room,
	str,
} from "@chat/app/v1";
import { type FileInfo, Files } from "@chat/app/v1/worker";

/** Every message of the channel, by its number. */
const Messages = defineTable("chat.messages", {
	version: 1,
	columns: { id: int(), author: str(), text: str(), at: num(), file: opt(json(Attachment, { version: 1 })) },
	key: ["id"],
});

/** The messages, newest first. */
const NEWEST = query(Messages).orderBy((message) => message.id, "desc");

/** How many messages the live query and a page of history hold. */
const PAGE = 100;

const Store = local("chat.store", {
	version: 1,
	params: {},
	members: {
		messages: arr(Message),
		add: method(obj({ author: str(), text: str(), file: opt(Attachment) })),
		history: method(obj({ before: opt(int()) }), arr(Message)),
	},
});

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const messages = self.table(Messages);
		// The newest messages, live.
		const newest = self.query(messages, NEWEST, PAGE);
		return {
			// Oldest first, as the room shows them.
			messages: self.derive([newest], ([rows]) => [...rows].reverse()),
			add: async ({ author, text, file }, ctx) => {
				await self.tx(async (tx) => {
					// The number after the newest message's: the store's transactions run one after another.
					const { items: last } = await tx.page(messages, NEWEST, 1);
					const id = (last[0]?.id ?? 0) + 1;
					tx.put(messages, { id, author, text, at: Date.now(), ...(file === undefined ? {} : { file }) });
				}, ctx);
				return null;
			},
			history: async ({ before }, ctx) => {
				const older = before === undefined ? NEWEST : NEWEST.where((message) => lt(message.id, before));
				const { items } = await messages.page(older, PAGE, ctx);
				return [...items].reverse();
			},
		};
	});
	host.serve(Room, (_params, principal, self) => {
		const store = self.get(Store, {});
		const files = self.get(Files, {});
		const author = (principal as { readonly name?: string }).name ?? principal.kind;
		return {
			variant: "main",
			members: {
				messages: self.derive([store.messages], ([messages]) => messages),
				history: (page, ctx) => store.history(page, ctx),
				post: (text, ctx) => store.add({ author, text }, ctx),
				// Each attachment is a file of the space `attachments`, at its name (a name sent twice is a new version).
				begin: async ({ name, mime }, ctx) => {
					const path = name.replaceAll("/", "_");
					const begun = await files.begin({ space: "attachments", path, mime, source: author }, ctx);
					// Without a key a begin always starts an upload.
					return begun.kind === "upload" ? begun.upload : "";
				},
				append: (chunk, ctx) => files.append(chunk, ctx),
				share: async ({ upload, text }, ctx) => {
					const file = await files.finish(upload, ctx);
					return store.add({ author, text, file: attachment(file) }, ctx);
				},
				attachment: async (id, ctx) => {
					const file = await files.file(id, ctx);
					if (file === null) throw new Error(`no file ${id}`);
					return attachment(file);
				},
				read: (range, ctx) => files.read(range, ctx),
			},
		};
	});
});

/** A file of the channel as an attachment of a message. */
function attachment(file: FileInfo): Attachment {
	return { id: file.id, name: file.path, mime: file.mime, size: file.size };
}
