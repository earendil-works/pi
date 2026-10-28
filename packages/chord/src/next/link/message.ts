// Messages (§22, R1, R4, 2b): the one `Message` type every link carries, defined as a TypeBox schema and checked after
// every decode, and the codecs that turn it into bytes.

import Type from "typebox";
import type { Context } from "../../context/index.ts";
import { arr, int, lit, obj, opt, type Static, str, union, unknown } from "../contracts/index.ts";
import { validatorFor } from "../data/internal.ts";
import type { Part } from "./part.ts";

/** A link-local id, chosen by its origin: a counter, unique per link, direction and origin while in use. */
const id = int({ min: 0 });

/**
 * Whose work a message is (decision "Relay flow control per origin"): a relay's number for one downstream link (and
 * the origin that link's messages carried), never reused on a link; absent for the sender's own work. Holds, calls,
 * windows and acks are keyed by (origin, id), and replies carry the origin of what they answer.
 */
const origin = int({ min: 1 });

/** A name as an index into the hold's bound version (each variant's names sorted). */
const index = int({ min: 0 });

/** An error that may come from plugin code: a ChordError's JSON (checked by L1), or a plugin's code and message. */
const wireError = union([
	obj({ kind: lit("chord"), error: unknown() }),
	obj({ kind: lit("plugin"), code: str(), message: str(), details: opt(unknown()) }),
]);

/** The members of a hold that failed with this message (W1). */
const failed = arr(obj({ member: index, error: wireError }));

/** A part's envelope: the codec built it, so any value passes (its content is the owner's to parse). */
const part = Type.Unsafe<Part>({});

/**
 * The byte segments of a payload part whose method's schema has a `bytes()` leaf, referenced from its JSON by
 * `{"$bytes": i}`; absent for every other payload. Built by the codec, like the part.
 */
const segments = opt(Type.Unsafe<readonly Uint8Array[]>({}));

/** An address as a hold names it: its host kind and params, checked against the kind where it is routed. */
const address = obj({ kind: str(), params: unknown() });

/** A principal on a hold: JSON with a `kind`, honoured only on a parent link. */
const principal = Type.Object({ kind: str() });

/** A uuidv7 as text. */
const incarnation = str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });

/** The longest activation chain a hold carries (Q5): a longer one keeps its last entries. */
export const CHAIN = 32;

/** The protocol's messages, one tagged union. Parts are opaque here (the owners parse them). */
const MESSAGE = union([
	// `calls`: how many concurrent calls this side accepts (the call window).
	obj({ kind: lit("hello"), protocol: int({ min: 0 }), incarnation, calls: int({ min: 1 }) }),
	obj({
		kind: lit("hold"),
		origin: opt(origin),
		hold: id,
		type: str(),
		version: int({ min: 1 }),
		fingerprint: str({ pattern: "^[0-9a-f]{16}$" }),
		params: part,
		// The address the caller computed (absent for a type without placement).
		address: opt(address),
		// Whom the hold acts for and the origin's incarnation; read only on a parent link.
		principal: opt(principal),
		incarnation: opt(incarnation),
		// The instance ids of the activations waiting for this hold (Q5); read only on a trusted link.
		chain: opt(Type.Array(incarnation, { maxItems: CHAIN })),
		// The decoded limit per part of the link the hold was admitted on (Q2); read only on a parent link.
		limit: opt(int({ min: 0 })),
	}),
	obj({ kind: lit("release"), origin: opt(origin), hold: id }),
	obj({ kind: lit("call"), origin: opt(origin), call: id, hold: id, method: index, args: opt(part), segments }),
	obj({ kind: lit("abort"), origin: opt(origin), call: id }),
	// Asks the provider for an attempt of a failed hold's object now (`ref.retry()`).
	obj({ kind: lit("retry"), origin: opt(origin), hold: id }),
	// Binds several holds at once (first bindings, re-holds), applied in one batch.
	obj({
		kind: lit("bound"),
		origin: opt(origin),
		holds: arr(obj({ hold: id, variant: index, members: arr(obj({ member: index, value: part })), failed })),
	}),
	obj({
		kind: lit("state"),
		origin: opt(origin),
		// `retired`: the members whose document was retired since the hold's last message (decision "One retirement
		// mechanism"); a `bound` snapshot carries no flag.
		holds: arr(obj({ hold: id, members: arr(obj({ member: index, ops: part })), failed, retired: arr(index) })),
	}),
	// One per applied `bound` or `state` message of its origin (the window).
	obj({ kind: lit("ack"), origin: opt(origin) }),
	// A relay's downstream link closed: the origin's holds are released and its calls aborted.
	obj({ kind: lit("closed"), origin }),
	// A revocation from the parent, applied with this host's own `revokedBy` (no origin).
	obj({ kind: lit("revoke"), revocation: unknown() }),
	obj({ kind: lit("ping") }),
	obj({ kind: lit("pong") }),
	obj({
		kind: lit("failed"),
		origin: opt(origin),
		hold: id,
		// A failure cause's error in the wire error format (a ChordError, checked by L1's envelope check, or a plugin's).
		cause: obj({ kind: union([lit("transient"), lit("broken")]), error: wireError }),
		// The rest of the object's backoff window in milliseconds: when it retries by itself (absent: broken).
		retryIn: opt(int({ min: 0 })),
	}),
	// The failed object of a hold started a new attempt.
	obj({ kind: lit("loading"), origin: opt(origin), hold: id }),
	obj({ kind: lit("result"), origin: opt(origin), call: id, value: opt(part), segments }),
	obj({ kind: lit("error"), origin: opt(origin), call: id, error: wireError }),
	obj({ kind: lit("gone"), origin: opt(origin), hold: id, error: wireError }),
]);

/**
 * A protocol message. `args` absent: a method without arguments; `value` absent: `null`. A `state` entry's `retired`
 * list is read-only (the schema's type is mutable): entries without retirements share `NO_RETIRED`.
 */
export type Message =
	| Exclude<WireMessage, WireState>
	| (Omit<WireState, "holds"> & { readonly holds: readonly StateEntry[] });

type WireMessage = Static<typeof MESSAGE>;

type WireState = Extract<WireMessage, { readonly kind: "state" }>;

/** An error as it crosses a link. */
export type WireError = Static<typeof wireError>;

/** A message that may carry an origin (every kind but `hello`, `revoke`, `ping` and `pong`). */
export type OriginMessage = Exclude<Message, { readonly kind: "hello" | "revoke" | "ping" | "pong" }>;

/** A message for a provider side: the direction from the consumer (`closed` is the link's). */
export type ProviderMessage = Extract<
	Message,
	{ readonly kind: "hold" | "release" | "call" | "abort" | "retry" | "ack" }
>;

/** A message for a consumer side: the direction from the provider. */
export type ConsumerMessage = Extract<
	Message,
	{ readonly kind: "bound" | "state" | "failed" | "loading" | "result" | "error" | "gone" }
>;

/** One hold's entry of a `bound` message. */
export type BoundEntry = Extract<Message, { readonly kind: "bound" }>["holds"][number];

/** One hold's entry of a `state` message. */
export type StateEntry = Omit<WireState["holds"][number], "retired"> & { readonly retired: readonly number[] };

/** The `retired` list of a state entry without retirements, shared (no allocation per message). */
export const NO_RETIRED: readonly number[] = [];

/** An address as a `hold` carries it. */
export type WireAddress = Static<typeof address>;

/** A member of a hold that failed, by index, as `bound` and `state` list it. */
export type FailedMember = Static<typeof failed>[number];

/** How a link turns messages into bytes and back; both ends of a link use the same one. */
export interface Codec {
	readonly name: string;
	encode(message: Message): Uint8Array;
	/** Throws on bytes that are no message of this codec (a protocol error); the envelope is checked afterwards. */
	decode(bytes: Uint8Array): Message;
}

const MESSAGE_SCHEMA = { schema: MESSAGE };

/**
 * Checks a decoded message's envelope with the compiled schema (the wire is a trust boundary, after any codec): kinds,
 * ids and indexes, lists and error shapes; not the parts. Throws on a mismatch (a protocol error). Counted in
 * `chord.link.checks`.
 */
export function checkMessage(message: unknown, context: Context): Message {
	context.telemetry.metrics?.counter("chord.link.checks").add(1);
	if (!validatorFor(MESSAGE_SCHEMA, context).Check(message)) throw new Error("message: fails the message schema");
	// The check above establishes the type.
	return message as Message;
}
