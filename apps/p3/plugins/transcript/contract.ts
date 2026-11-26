// The transcript plugin's contract: a session's main conversation as the people let into the session see it, by the
// session's ticks (decision 76: the transcript is no thing, the session kind owns it): Read gives Durable's live view
// (a window over the entries, the running answer, the queue) and the older entries, Send the composer's call, Stop
// the stop. One object per session's conversation on the worker follows Durable once, however many people watch.
// `/v1` re-exports it.

import { arr, bool, grantable, int, method, obj, opt, remote, Session, str, unknown } from "@earendil-works/p3/v1";

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

/**
 * A session's main conversation: Durable's conversation view (`null` until it arrived) and older entries (Read),
 * `send` (Send) and `stop` (Stop), each granted by the caller's ticks on the session (`TRANSCRIPT_GRANTS`).
 */
export const Transcript = remote("transcript.transcript", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: obj({}),
	state: { view: grantable(unknown()) },
	methods: {
		entries: grantable(method(EntriesQuery, EntriesPage)),
		send: grantable(method(Send)),
		stop: grantable(method()),
	},
});

/** What each of the session kind's ticks grants of its transcript. */
export const TRANSCRIPT_GRANTS = { read: ["view", "entries"], send: ["send"], stop: ["stop"] } as const;

/** The members of `Transcript` the session's `ticks` grant (see `TRANSCRIPT_GRANTS`). */
export function transcriptGrants(ticks: ReadonlySet<string>): ("view" | "entries" | "send" | "stop")[] {
	return Object.entries(TRANSCRIPT_GRANTS).flatMap(([tick, members]) => (ticks.has(tick) ? [...members] : []));
}
