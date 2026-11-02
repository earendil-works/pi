// The chat plugin on a channel's worker: the room's messages in a document of the worker's store (kept by a local
// object: a persisted state needs a stable identity), and each principal's `Room` posting as them and sharing files
// through the kit's `Files` of this worker.

import {
	Attachment,
	arr,
	defineFacet,
	defineState,
	local,
	Message,
	method,
	num,
	obj,
	opt,
	Room,
	str,
} from "@chat/app/v1";
import { Files } from "@chat/app/v1/worker";

/** The newest messages a channel keeps. */
const KEPT = 500;

const Log = defineState("chat.log", {
	schema: obj({ next: num(), messages: arr(Message) }),
	version: 1,
	initial: () => ({ next: 1, messages: [] }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

const Store = local("chat.store", {
	version: 1,
	params: {},
	members: { messages: arr(Message), add: method(obj({ author: str(), text: str(), file: opt(Attachment) })) },
});

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const log = self.state(Log);
		return {
			messages: self.derive([log], ([value]) => value.messages),
			add: async ({ author, text, file }, ctx) => {
				await log.change((draft) => {
					draft.messages.push({
						id: draft.next++,
						author,
						text,
						at: Date.now(),
						...(file === undefined ? {} : { file }),
					});
					if (draft.messages.length > KEPT) draft.messages.splice(0, draft.messages.length - KEPT);
				}, ctx);
				return null;
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
				post: (text, ctx) => store.add({ author, text }, ctx),
				begin: (file, ctx) => files.begin(file, ctx),
				append: (chunk, ctx) => files.append(chunk, ctx),
				share: async ({ upload, text }, ctx) => {
					const id = await files.finish(upload, ctx);
					const { name, mime, size } = files.list.value.find((file) => file.id === id)!;
					return store.add({ author, text, file: { id, name, mime, size } }, ctx);
				},
				read: (range, ctx) => files.read(range, ctx),
			},
		};
	});
});
