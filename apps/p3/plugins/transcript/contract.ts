// The transcript plugin's contract: a session's main conversation as its members see it. Readers get Durable's live
// view (a window over the entries, the running answer, the queue) and page what lies before it; writers also send and
// stop. One object per session's conversation on the worker follows Durable once, however many people watch.
// `/v1` re-exports it.

import { arr, bool, int, method, obj, opt, remote, Session, str, unknown } from "@earendil-works/p3/v1";
import { SessionAdmission } from "../sessions/contract.ts";

/** A page of entries before (or between) what a view holds: Durable's entries, newest last, and whether more lie before. */
export const EntriesPage = obj({ items: arr(unknown()), more: bool() });

/** What `entries` takes: Durable's entry query (ids from the view's entries) and a limit (at most 100). */
export const EntriesQuery = obj({
	minEntryId: opt(int()),
	maxEntryId: opt(int()),
	order: opt(str()),
	limit: int({ min: 1, max: 100 }),
});

/** A message to send: its text and a client-chosen id (a retried send with the same id is taken once). */
export const Send = obj({ text: str({ min: 1, max: 1_000_000 }), requestId: str({ min: 1, max: 200 }) });

/** The reader's members: Durable's conversation view (`null` until it arrived) and older entries. */
const reader = {
	state: { view: unknown() },
	methods: { entries: method(EntriesQuery, EntriesPage) },
};

/** A session's main conversation, for its members: readers see it, writers also send and stop. */
export const Transcript = remote("transcript.transcript", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: SessionAdmission,
	variants: {
		reader,
		writer: {
			state: reader.state,
			methods: { ...reader.methods, send: method(Send), stop: method() },
		},
	},
});
