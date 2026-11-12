// Rooms of custom views (docs/rooms.md): what a view's frames share on the server (presence, messages, a base state,
// the clock, the agent's calls to methods a frame offers), how a page gets a frame its link, and what the server reads
// of the view from the session's worker. Imported by the server, the worker, the page and the view kit.
import {
	arr,
	bool,
	int,
	nul,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import {
	evolve,
	forViews,
	type JsonValue,
	literal,
	method,
	param,
	record,
	remote,
	serverHost,
	sessionHost,
	unsafe,
} from "@p2/app/v1";
import { VIEW_ID } from "./contract.ts";

/** The kinds of rooms: live (presence and messages), log (messages since a snapshot), text (server-applied edits). */
export const RoomKindSchema = oneOf(["live", "log", "text"] as const);
export type RoomKind = Static<typeof RoomKindSchema>;

const Json = unsafe<JsonValue>(unknown());
const ViewId = param.str({ pattern: VIEW_ID.source });
const Name = str({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" });

/** One of a room's peers: a frame of the view on its own link (its ID is the server-minted link ID). */
export const PeerSchema = obj({
	id: str(),
	name: str(),
	role: oneOf(["owner", "guest"] as const),
	mode: oneOf(["read", "write"] as const),
});
export type Peer = Static<typeof PeerSchema>;

/** Who is in the room, and the leader: the oldest present peer that may write (null: none). */
export const PresenceSchema = obj({ peers: arr(PeerSchema), leader: nullable(str()) });
export type Presence = Static<typeof PresenceSchema>;

/** An unkeyed message as the room numbered it: `data` is JSON text (the kit stringifies and parses). */
export const MessageSchema = obj({
	seq: int(),
	from: str(),
	data: str(),
	/** Text rooms: the editor's batch number, when the message is a batch of edits (`data`: the edits, as JSON). */
	n: opt(int()),
});
export type Message = Static<typeof MessageSchema>;

/** The window of the journal every peer holds: all its messages after `start` (older ones: `history`). */
export const LogSchema = obj({ start: int(), messages: arr(MessageSchema) });
export type Log = Static<typeof LogSchema>;

/**
 * A peer's newest message for one key: the object stays, a newer message sets its two leaves. `data`'s first
 * character is a tag that differs from the previous value's (`0` or `1`), the JSON text follows: Delta writes a string
 * that shares a prefix with the old one as a truncation and an append, which do not fold; a tag that differs makes it
 * a set, which does (`delta/pending.ts`).
 */
export const KeyedSchema = obj({ seq: int(), data: str() });

/** `data` tagged to differ from `previous` (a keyed entry's current `data`), see `KeyedSchema`. */
export const tagged = (data: string, previous: string | undefined): string =>
	`${previous?.startsWith("0") ? "1" : "0"}${data}`;
/** Keyed messages by peer, then key. */
export const KeyedByPeerSchema = obj({ peers: record(record(KeyedSchema)) });
export type KeyedByPeer = Static<typeof KeyedByPeerSchema>;

/** What a log or text room starts from: the view's state at message `seq`; `epoch` grows when it was replaced. */
export const BaseSchema = obj({ seq: int(), epoch: int(), value: Json });
export type Base = Static<typeof BaseSchema>;

/** A method a frame offers the agent: its name, what it does, its arguments' JSON Schema. */
export const MethodInfoSchema = obj({
	name: Name,
	description: str({ maxLength: 2000 }),
	args: Json,
	/** Safe to run again: a call whose peer left is given to the next leader. */
	idempotent: opt(bool()),
});
export type MethodInfo = Static<typeof MethodInfoSchema>;

/** A call the agent made, for the peer it is pinned to. */
export const CallSchema = obj({ id: str(), method: str(), args: Json, peer: str() });
export type Call = Static<typeof CallSchema>;

/**
 * The room's own facts: the store's incarnation (a new store, after the last one ended, numbers from 0 again), its
 * kind, last number, base, the leader's term, the calls waiting.
 */
export const RoomSchema = obj({
	store: str(),
	kind: nullable(RoomKindSchema),
	seq: int(),
	term: int(),
	base: nullable(BaseSchema),
	calls: arr(CallSchema),
});
export type Room = Static<typeof RoomSchema>;

/** An element ID of a text room (articulated's `ElementId`). */
export const TextIdSchema = obj({ bunchId: str({ minLength: 1, maxLength: 64 }), counter: int({ minimum: 0 }) });
/** One edit of a text room: insert `content` right after `before`, or delete what lies from `start` to `end`. */
export const TextEditSchema = union([
	obj({
		kind: literal("insert"),
		before: nullable(TextIdSchema),
		id: TextIdSchema,
		content: str({ minLength: 1, maxLength: 100_000 }),
		inWord: bool(),
	}),
	obj({ kind: literal("delete"), start: TextIdSchema, end: TextIdSchema, length: int({ minimum: 1 }) }),
]);

/** What a peer sends: messages with an optional key, their data as JSON text. */
export const OutgoingSchema = arr(obj({ key: opt(str({ minLength: 1, maxLength: 64 })), data: str() }), {
	maxItems: 1000,
});
export const JoinedSchema = obj({ me: str(), editor: str(), from: int() });
export const HistoryArgsSchema = obj({ after: int(), limit: int({ minimum: 1, maximum: 1000 }) });
/** Journal messages after a number; `more`: the journal has more after the last one. */
export const HistorySchema = obj({ messages: arr(MessageSchema), more: bool() });
/** A call's answer: its result, or why it failed. */
export const AnswerSchema = obj({ id: str(), result: opt(Json), error: opt(str({ maxLength: 4000 })) });
export const SnapshotSchema = obj({ seq: int(), epoch: int(), term: int(), value: Json });
export const EditBatchSchema = obj({ n: int({ minimum: 1 }), edits: arr(TextEditSchema, { maxItems: 1000 }) });
export const CallArgsSchema = obj({ method: Name, args: Json });

/**
 * A view's room (server), version 1 as 682c7b93c released it: the contract the view kits built then hold. Version 2
 * (`ViewRoom`) serves it through its `accepts` (`rooms.ts`); kept verbatim, as its fingerprint must not change.
 */
export const ViewRoomV1 = remote("p2.view-room", {
	version: 1,
	params: { session: param.str(), view: ViewId, opening: param.str() },
	hostAddress: serverHost,
	variants: {
		peer: {
			state: {
				room: RoomSchema,
				presence: PresenceSchema,
				log: LogSchema,
				keyed: KeyedByPeerSchema,
			},
			methods: {
				join: method(obj({ kind: opt(RoomKindSchema) }), JoinedSchema),
				send: method(obj({ messages: OutgoingSchema, ack: opt(int()) })),
				ack: method(obj({ seq: int() })),
				history: method(HistoryArgsSchema, HistorySchema),
				now: method(undefined, num()),
				offer: method(obj({ methods: arr(MethodInfoSchema, { maxItems: 100 }) })),
				answer: method(AnswerSchema),
				snapshot: method(SnapshotSchema),
				edit: method(EditBatchSchema),
			},
		},
		worker: {
			methods: {
				methods: method(undefined, arr(MethodInfoSchema)),
				call: method(CallArgsSchema, Json),
			},
		},
	},
});

/** A message of a room's stream (an event): its sender (a peer ID), its key if any, its data as JSON text. */
export const StreamSchema = obj({ from: str(), key: opt(str()), data: str() });
export type Stream = Static<typeof StreamSchema>;

/** The numbers a send's messages were given, in their order. */
export const SentSchema = arr(int());

/**
 * A view's room (server): `peer` for the frames of one opening of the view (view principals), `worker` for the
 * session's worker (the agent's `view_methods` and `view_call`). In memory; it ends a little after its last peer.
 *
 * - `join`: joins (as a room of `kind`, if given: the first one present decides it); the caller's peer and editor IDs,
 *   and the last number before it joined (a live room's joiner takes messages after it; keyed ones all). A frame that
 *   only offers methods joins without a kind.
 * - `send`: numbers and adds messages, answering their numbers in order; `ack`: the last number the caller applied
 *   (the room keeps the highest it saw).
 * - `emit` and `stream` (version 2): motion. An emit's messages go to every peer bound now, as events of `stream`,
 *   unnumbered, never kept, dropped for a peer that cannot keep up.
 * - `history`: journal messages after `after`; `now`: the server's clock; `offer` and `answer`: methods for the agent;
 *   `snapshot`: a log room's leader saves the state after message `seq`; `edit`: a text room's batch of edits.
 *
 * 2: `stream`, `emit`, and `send` answers the numbers it gave (version 1's frames get `null`).
 */
export const ViewRoom = forViews(
	evolve(ViewRoomV1, (e) =>
		e
			.addEvent("peer", "stream", StreamSchema)
			.addMethod("peer", "emit", obj({ messages: OutgoingSchema }), nul())
			.result("send", SentSchema),
	),
);

/** A page's way to a frame's link: a token for one view of the session, for people who may view it. */
export const ViewLinks = remote("p2.view-links", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: {
		viewer: {
			methods: {
				/**
				 * A token for `/chord/view` (single use, one minute) and the view's current opening; `editor`: the editor a
				 * reconnecting frame had (from its first token).
				 */
				token: method(
					obj({ view: str({ pattern: VIEW_ID.source }), editor: opt(str()) }),
					obj({ token: str(), opening: str(), editor: str() }),
				),
			},
		},
	},
});

/** The current opening of each custom view of the session (worker, for the server only). */
export const ViewOpenings = remote("p2.view-openings", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: { server: { state: { openings: record(str()) } } },
});

/** A view's state as its room sees it: the value, its revision, and whose write it was (the room's, or another's). */
export const BackedStateSchema = obj({ value: Json, revision: int(), by: oneOf(["room", "other"] as const) });
export type BackedState = Static<typeof BackedStateSchema>;

/**
 * One opening of a custom view, as its room reads and writes it (worker, for the server only): the view's state, and
 * the room's own document (a text room's text, IDs and watermarks), which nothing else writes.
 */
export const ViewBacking = remote("p2.view-backing", {
	version: 1,
	params: { session: param.str(), view: ViewId, opening: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			state: { current: BackedStateSchema, room: Json },
			methods: {
				/**
				 * Sets the view's state and the room's document (each if given), only while the state's revision is still
				 * `revision` and the opening current; false otherwise (nothing written).
				 */
				write: method(obj({ revision: int(), value: opt(Json), room: opt(Json) }), bool()),
			},
		},
	},
});
