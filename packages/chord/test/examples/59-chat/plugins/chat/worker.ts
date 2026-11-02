// The chat plugin on a channel's worker: the room's messages in a table of the worker's store (every message kept),
// written and read by one local object. Tables have no watch, so the object keeps the live window itself: the newest
// 100 messages, read at activation and appended to after each post (it is the only writer); older ones are read by
// page on request. Each principal's `Room` posts as them and shares files through the kit's `Files` of this worker.

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
import { Files } from "@chat/app/v1/worker";

/** Every message of the channel, by its number. */
const Messages = defineTable("chat.messages", {
	version: 1,
	columns: { id: int(), author: str(), text: str(), at: num(), file: opt(json(Attachment, { version: 1 })) },
	key: ["id"],
});

/** The messages, newest first. */
const NEWEST = query(Messages).orderBy((message) => message.id, "desc");

/** How many messages the live window and a page of history hold. */
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
		// The newest messages (oldest first) and the next message's number: read once, then kept here.
		const window = self.writable<Message[]>([]);
		let next = 1;
		self.open(
			async (ctx) => {
				const { items } = await messages.page(NEWEST, PAGE, ctx);
				window.set([...items].reverse());
				next = (items[0]?.id ?? 0) + 1;
			},
			() => {},
		);
		return {
			messages: self.derive([window], ([value]) => value),
			add: async ({ author, text, file }, ctx) => {
				const message = { id: next++, author, text, at: Date.now(), ...(file === undefined ? {} : { file }) };
				await self.tx(async (tx) => tx.put(messages, message), ctx);
				// In number order: two posts may commit in either order.
				window.set([...window.value, message].sort((a, b) => a.id - b.id).slice(-PAGE));
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
				begin: (file, ctx) => files.begin(file, ctx),
				append: (chunk, ctx) => files.append(chunk, ctx),
				share: async ({ upload, text }, ctx) => {
					const id = await files.finish(upload, ctx);
					return store.add({ author, text, file: attachment(files.list.value, id) }, ctx);
				},
				attachment: async (id) => attachment(files.list.value, id),
				read: (range, ctx) => files.read(range, ctx),
			},
		};
	});
});

/** The attachment `id` of the channel's files; throws when there is none. */
function attachment(list: readonly Attachment[], id: string): Attachment {
	const file = list.find((each) => each.id === id);
	if (file === undefined) throw new Error(`no file ${id}`);
	return { id, name: file.name, mime: file.mime, size: file.size };
}
