// The chat's API, version 1, shared by every host kind (`@chat/app/v1`): the part of Chord its plugins and clients use,
// and the chat's own contracts. A channel is a worker of its own (`Channel({ id })`); its `Room` lives there, with the
// messages in the worker's store and the attachments in its files. The server keeps the channel list (`Channels`).

import { arr, bytes, hostKind, int, method, num, obj, opt, remote, type Static, str } from "../../../../src/index.ts";

export { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
export {
	arr,
	constant,
	defineFacet,
	defineState,
	local,
	method,
	num,
	obj,
	opt,
	str,
} from "../../../../src/index.ts";

/** A channel: one worker each. */
export const Channel = hostKind("channel", { id: str() });

/** A file shared in a message: its id in the channel's files, its name, type and size. */
export const Attachment = obj({ id: str(), name: str(), mime: str(), size: int() });

/** A message: its number, author, text, time, and maybe a file. */
export const Message = obj({ id: int(), author: str(), text: str(), at: num(), file: opt(Attachment) });

/** A message (see `Message`). */
export type Message = Static<typeof Message>;

/**
 * A channel's room, on its worker: its messages, posting, and sharing a file in chunks (`begin`, `append` at the
 * stored offset, `share` posts it) and reading one back (`read`, at most 4 MiB a call).
 */
export const Room = remote("chat.room", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Channel({ id }),
	variants: {
		main: {
			state: { messages: arr(Message) },
			methods: {
				post: method(str()),
				begin: method(obj({ name: str(), mime: str() }), str()),
				append: method(obj({ upload: str(), offset: int(), bytes: bytes() })),
				share: method(obj({ upload: str(), text: str() })),
				read: method(obj({ id: str(), offset: int(), length: int() }), bytes()),
			},
		},
	},
});

/** The channel list, on the server. */
export const Channels = remote("chat.channels", {
	version: 1,
	params: {},
	hostAddress: () => hostKind("server")(),
	variants: { main: { state: { names: arr(str()) } } },
});
