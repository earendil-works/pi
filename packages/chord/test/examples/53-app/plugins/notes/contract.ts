// A project's notes: served by the project's worker (`Project({ id })`), reached from the server by id.

import { method, obj, Project, remote, str } from "@notes/app/v1";

export const Notes = remote("notes.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Project({ id }),
	variants: {
		main: {
			state: { text: str(), start: str() },
			methods: {
				/** Replaces the project's text. */
				write: method(str()),
				/** Stores an attachment in the project's files; its id. */
				attach: method(obj({ name: str(), body: str() }), str()),
				/** An attachment's text. */
				attachment: method(str(), str()),
			},
		},
	},
});
