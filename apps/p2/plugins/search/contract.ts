import { arr, bool, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	evolve,
	literal,
	local,
	method,
	param,
	propertiesOf,
	record,
	remote,
	serverHost,
	sessionHost,
} from "@p2/app/v1";

/** One committed user or assistant message of a session conversation, as indexed. */
export const IndexedMessageSchema = obj({
	conversationId: num(),
	entryId: num(),
	role: union([literal("user"), literal("assistant")]),
	timestamp: num(),
	text: str(),
});
export type IndexedMessage = Static<typeof IndexedMessageSchema>;

const MessageHitSchema = obj({
	session: str(),
	conversationId: num(),
	entryId: num(),
	role: union([literal("user"), literal("assistant")]),
	/** A bounded snippet around the match. */
	text: str(),
});
export const SearchHitSchema = obj({ ...propertiesOf(MessageHitSchema), title: str() });

export const SearchResultsSchema = obj({
	/** Sessions whose title or working directory contains the query, in sidebar order. */
	sessions: arr(str()),
	/** Best message matches first (at most 41: the drawer shows 40 and whether there are more). */
	messages: arr(SearchHitSchema),
});
export type SearchResults = Static<typeof SearchResultsSchema>;

const QuerySchema = obj({
	query: str({ maxLength: 500 }),
	/** Search archived sessions instead of active ones. */
	archived: opt(bool()),
});

const BatchSchema = obj({
	conversation: opt(num({ default: 1 })),
	activityAt: opt(num()),
	messages: arr(IndexedMessageSchema, { maxItems: 1000 }),
	/** The cursor after this batch: entries up to here are indexed (unchanged until the last page of a range). */
	through: num(),
});

/** A conversation's own matches, for the history tools: entry, role and a bounded snippet. */
export const HistoryHitsSchema = obj({
	hits: arr(
		obj({
			entryId: num(),
			role: union([literal("user"), literal("assistant")]),
			snippet: str(),
		}),
	),
	more: bool(),
	/** The entry ID up to which the conversation is indexed: later entries are not searchable yet. */
	indexedThrough: num(),
});
export type HistoryHits = Static<typeof HistoryHitsSchema>;
const HistoryQuerySchema = obj({
	/** Keywords as the model wrote them (see `ftsQuery`); never raw FTS syntax. */
	query: str({ maxLength: 500 }),
	conversation: num(),
	/** Only entries with smaller IDs. */
	before: opt(num()),
	limit: int({ minimum: 1, maximum: 20 }),
});

/** A session's index rebuild: running, or failed with why (kept until the next rebuild of that session). */
export const RebuildSchema = union([
	obj({ session: str(), phase: literal("running") }),
	obj({ session: str(), phase: literal("failed"), error: str() }),
]);
export type Rebuild = Static<typeof RebuildSchema>;

/** Root conversation entry IDs by session. */
const EntryIdsSchema = record(num());

/**
 * The full-text index of every session's messages (root and children) (server, host-internal, SQLite `search.sqlite`). Derived and
 * rebuildable: a schema change drops it, and workers catch up from their cursors (0) at their next start.
 */
export const SearchIndex = local("p2.search-index", {
	/** 2: `mentions`. Only the server's plugins hold it, and they reload with it: no `accepts`. */
	version: 2,
	params: {},
	members: {
		/** The entry ID up to which the chosen conversation is indexed (0: nothing). */
		cursor: method(obj({ session: str(), conversation: opt(num({ default: 1 })) }), num()),
		/** Commits a batch (idempotent by entry ID) and advances the cursor; returns once committed. */
		index: method(obj({ session: str(), ...propertiesOf(BatchSchema) })),
		/** Drops a session's messages and cursor (its worker re-indexes from the start). */
		reset: method(obj({ session: str() })),
		/** Each session's latest answer in its root conversation (its assistant entry ID), as indexed. */
		answers: EntryIdsSchema,
		/** Up to which root entry the owner has read each session (persisted; owners only, see `SessionReads`). */
		reads: EntryIdsSchema,
		markRead: method(obj({ session: str(), through: num() })),
		/** One conversation's matches (history tools); bounds before ranking and the limit. */
		history: method(obj({ session: str(), ...propertiesOf(HistoryQuerySchema) }), HistoryHitsSchema),
		/** Message matches among `sessions` (literal terms, all required). */
		messages: method(obj({ query: str(), sessions: arr(str()) }), arr(MessageHitSchema)),
		/**
		 * The sessions with a message matching `query` (keywords as `ftsQuery` reads them, all required) at or after
		 * `since`, each with the time of its latest one (rollups' `mentions`).
		 */
		mentions: method(obj({ query: str({ minLength: 1, maxLength: 500 }), since: opt(num()) }), record(num())),
		/** The index rebuilds running or failed (a job each: they survive a server restart). */
		rebuilds: arr(RebuildSchema),
		/** Starts re-indexing `session` from the start (`Search.rebuildIndex`); refuses an unknown session. */
		rebuild: method(obj({ session: str() })),
	},
});

/**
 * A session worker's feed into the index (worker principals only, scoped to their session). Acknowledged catch-up:
 * the worker scans its immutable history from the cursor and sends pages; each call returns after the server
 * committed it, and the cursor moves only after a whole range committed, so an interrupted scan is retried.
 */
export const SearchFeed = remote("p2.search-feed", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				cursor: method(union([nul(), obj({ conversation: num() })]), num()),
				index: method(BatchSchema),
				/** Searches one of this worker's own conversations (the history tools); the session is the worker's. */
				history: method(HistoryQuerySchema, HistoryHitsSchema),
			},
		},
	},
});

/** Search over session titles, working directories and message text (owner only): the base of the history. */
const SearchV1 = remote("p2.search", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			methods: {
				search: method(QuerySchema, SearchResultsSchema),
				/**
				 * Re-indexes one session from the start (Pi Mobile's `rebuildIndex`): its worker stops, its index entries
				 * go, and a fresh worker scans its history; an archived session's worker scans without resuming work and
				 * stops again.
				 */
				rebuildIndex: method(obj({ session: str() })),
			},
		},
	},
});

/** 2: `rebuildIndex` answers once the rebuild started (a job); `rebuilds` shows it running, and why it failed. */
const SearchV2 = evolve(SearchV1, (e) => e.addState("owner", "rebuilds", arr(RebuildSchema)));

/**
 * Search over session titles, working directories and message text (owner only). 3: `sessions` limits a search to those
 * sessions before ranking and the 41-hit limit (a sidebar list's own sessions). The provider still serves 1 and 2.
 */
export const Search = evolve(SearchV2, (e) =>
	e.args(
		"search",
		obj({ ...propertiesOf(QuerySchema), sessions: opt(arr(str({ maxLength: 64 }), { maxItems: 10_000 })) }),
	),
);

/**
 * Unread answers (owners only): a session is unread while its latest root answer (`answers`) is newer than what an owner
 * has read (`reads`), on any device. A browser marks a session read when its root conversation is shown.
 */
export const SessionReads = remote("p2.session-reads", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { answers: EntryIdsSchema, reads: EntryIdsSchema },
			methods: { markRead: method(obj({ session: str(), through: num() })) },
		},
	},
});

/** A session worker's indexer as the server's rebuild waits for it (the server's broker principal only). */
export const IndexScan = remote("p2.search-index-scan", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				/** Resolves once this worker's indexer has completed its first full scan. */
				scanned: method(),
			},
		},
	},
});
