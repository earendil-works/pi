import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { DescriptionSchema } from "./contract.ts";
import { CHORD_ERROR_CODES, ChordError } from "./errors.ts";

// JSON frames between two hosts (or a host and a client). Ids are chosen by the side that creates the hold, call or
// subscription; every frame type has one direction, so ids never collide:
//   consumer → provider: hold, release, call, cancel, sub, unsub, resync
//   provider → consumer: shape, gone, result, state
// State is addressed by (hold id, member): a hold implies the state of its variant, sent as units (a shape followed by
// a snapshot of each member the consumer lacks; see Connection).
//   both: hello, ping, pong, bye, root_end, ack; parent → child: invalidate, prepare, commit, abort, retire;
//   child → parent: vote
//
// Each frame is declared once, as the schema every received frame is checked against (`isFrame`); the types are derived
// from it. Payloads (hold inputs, call args, results, snapshots) stay `unknown`: they are validated where they are
// used, against the contract. State ops are checked op by op by the delta decoder.

/**
 * The link protocol version, announced in `hello`. Peers of different versions do not talk: the side that notices
 * closes the link with reason `protocol-version <its version>`, so the other side learns it too
 * (`LinkOptions.onProtocolMismatch`).
 */
export const PROTOCOL_VERSION = 4;

const Id = Type.Integer({ minimum: 1 });
const Name = Type.String({ minLength: 1 });
const Reload = Type.Integer({ minimum: 1 });
/** Arrays a sender may pass as readonly. */
const List = <T extends TSchema>(item: T) => Type.Immutable(Type.Array(item));

const RootRefSchema = Type.Object({ rootId: Name, codeVersion: Type.Integer({ minimum: 1 }) });
export type RootRef = Static<typeof RootRefSchema>;

const WireErrorSchema = Type.Object({
	code: Type.Enum(CHORD_ERROR_CODES),
	message: Type.String(),
	reason: Type.Optional(Type.String()),
});
export type WireError = Static<typeof WireErrorSchema>;

const WireReloadOptionsSchema = Type.Object({
	remove: Type.Optional(List(Type.String())),
	gateDeadline: Type.Optional(Type.Number()),
	retireDeadline: Type.Optional(Type.Number()),
});
export type WireReloadOptions = Static<typeof WireReloadOptionsSchema>;

/** A child's prepared reload, sent with its vote (same fields as `ReloadReport`, without children). */
const WireReloadReportSchema = Type.Object({
	codeVersion: Type.Integer(),
	previous: Type.Integer(),
	changed: List(Type.String()),
	removed: List(Type.String()),
	prepared: List(Type.String()),
	gated: List(Type.String()),
});
export type WireReloadReport = Static<typeof WireReloadReportSchema>;

const FrameSchema = Type.Union([
	Type.Object({
		t: Type.Literal("hello"),
		/** The link protocol version (`PROTOCOL_VERSION`; absent: 1). Peers of another version close the link. */
		protocol: Type.Optional(Type.Integer({ minimum: 1 })),
		name: Name,
		kind: Type.Union([Type.Literal("host"), Type.Literal("client")]),
		codeVersion: Type.Integer({ minimum: 0 }),
		/** The sender acknowledges what it receives (`ack`). Flow control applies only when both hellos say so. */
		acks: Type.Optional(Type.Boolean()),
	}),
	/** Every frame received so far except `ack` frames, counted from the link's start, once processed. */
	Type.Object({ t: Type.Literal("ack"), n: Type.Integer({ minimum: 1 }) }),
	Type.Object({
		t: Type.Literal("hold"),
		id: Id,
		/**
		 * Target host name, resolved by the consumer from the token's `host` and `input`. Relays route on it after
		 * checking it against both; the target refuses an input its own contract places elsewhere.
		 */
		at: Name,
		/** The consumer's contract token; the provider checks that it covers it. Remote tokens carry `host`. */
		token: DescriptionSchema,
		/** Normalized with the consumer's contract. */
		input: Type.Unknown(),
		/** A forwarded principal. Honored only on frames from the parent link. */
		principal: Type.Optional(Type.Unknown()),
		/**
		 * The client connection the hold comes from: an opaque id the server assigned to it, forwarded by relays. Honored
		 * only on frames from the parent link; present means the hold is a client's (not a reload participant).
		 */
		origin: Type.Optional(Name),
		/** False: no state for this hold until `sub` (a method-only binding). */
		state: Type.Optional(Type.Literal(false)),
		/** The consumer already has values (a re-hold after a link loss): its unit is not urgent. */
		again: Type.Optional(Type.Literal(true)),
	}),
	Type.Object({ t: Type.Literal("release"), id: Id }),
	Type.Object({
		t: Type.Literal("shape"),
		id: Id,
		variant: Type.Optional(Type.String()),
		members: List(Type.String()),
		contract: Type.String(),
		/** The state members whose snapshots follow this frame; the consumer applies the shape once they are here. */
		state: List(Name),
	}),
	Type.Object({ t: Type.Literal("gone"), id: Id, error: WireErrorSchema }),
	Type.Object({
		t: Type.Literal("call"),
		id: Id,
		hold: Id,
		member: Name,
		args: Type.Optional(Type.Unknown()),
		/** Absent: the receiving host starts a root (browsers never carry roots). */
		root: Type.Optional(RootRefSchema),
	}),
	Type.Object({
		t: Type.Literal("result"),
		id: Id,
		value: Type.Optional(Type.Unknown()),
		error: Type.Optional(WireErrorSchema),
	}),
	Type.Object({ t: Type.Literal("cancel"), id: Id }),
	/** Starts the state of a hold opened with `state: false` (answered with a unit). */
	Type.Object({ t: Type.Literal("sub"), hold: Id }),
	/** Stops the state of a hold. */
	Type.Object({ t: Type.Literal("unsub"), hold: Id }),
	/** Sends member `m` again as a reset (a relay that had to drop what waited for it). */
	Type.Object({ t: Type.Literal("resync"), hold: Id, m: Name }),
	Type.Object({
		t: Type.Literal("state"),
		hold: Id,
		m: Name,
		/** `snap`/`reset` without `value`: the value is `undefined`. */
		as: Type.Union([Type.Literal("snap"), Type.Literal("reset"), Type.Literal("ops"), Type.Literal("error")]),
		value: Type.Optional(Type.Unknown()),
		/** Encoded with the stream's delta encoder; the decoder validates each op. */
		ops: Type.Optional(List(List(Type.Unknown()))),
		error: Type.Optional(WireErrorSchema),
	}),
	Type.Object({ t: Type.Literal("ping"), n: Type.Integer() }),
	Type.Object({ t: Type.Literal("pong"), n: Type.Integer() }),
	/** Ends the link (consumed by the link itself). `reason: "protocol-version <n>"`: the sender speaks version n. */
	Type.Object({ t: Type.Literal("bye"), reason: Type.Optional(Type.String()) }),
	/** The root ended at its origin: its leases on objects end (sent on every link the root's calls used). */
	Type.Object({ t: Type.Literal("root_end"), rootId: Name }),
	Type.Object({ t: Type.Literal("invalidate"), pattern: Type.Record(Type.String(), Type.Unknown()) }),
	Type.Object({
		t: Type.Literal("prepare"),
		reload: Reload,
		codeVersion: Type.Integer({ minimum: 1 }),
		plugins: List(Type.String()),
		options: WireReloadOptionsSchema,
	}),
	Type.Object({
		t: Type.Literal("vote"),
		reload: Reload,
		error: Type.Optional(WireErrorSchema),
		report: Type.Optional(WireReloadReportSchema),
	}),
	Type.Object({ t: Type.Literal("commit"), reload: Reload }),
	/** The parent dropped `codeVersion`: roots of it may still come from there no longer. */
	Type.Object({ t: Type.Literal("retire"), codeVersion: Type.Integer({ minimum: 1 }) }),
	Type.Object({ t: Type.Literal("abort"), reload: Reload }),
]);
export type Frame = Static<typeof FrameSchema>;

/** A frame that passes validation; anything else is a protocol violation. */
export const isFrame = (value: unknown): value is Frame => Value.Check(FrameSchema, value);

export function toWireError(error: unknown): WireError {
	if (error instanceof ChordError) {
		return error.reason === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, reason: error.reason };
	}
	return { code: "unavailable", message: error instanceof Error ? error.message : String(error) };
}

export const fromWireError = (error: WireError): ChordError =>
	new ChordError(error.code, error.message.replace(/^[a-z_]+(\/[a-z_]+)?: /, ""), { reason: error.reason });
