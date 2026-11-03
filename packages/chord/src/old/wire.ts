import {
	arr,
	bool,
	compile,
	int,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Properties,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
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

const Id = int({ minimum: 1 });
const Name = str({ minLength: 1 });
const Reload = int({ minimum: 1 });
/** Arrays a sender may pass as readonly: the same schema, a readonly type. */
const List = <T>(item: Schema<T>) => arr(item) as Schema<readonly T[]>;
/** An object that admits fields it does not name (a newer peer's), as every frame does. */
const Open = <const P extends Properties>(properties: P) => obj(properties, { open: true });

const RootRefSchema = Open({ rootId: Name, codeVersion: int({ minimum: 1 }) });
export type RootRef = Static<typeof RootRefSchema>;

const WireErrorSchema = Open({
	code: oneOf(CHORD_ERROR_CODES),
	message: str(),
	reason: opt(str()),
});
export type WireError = Static<typeof WireErrorSchema>;

const WireReloadOptionsSchema = Open({
	remove: opt(List(str())),
	gateDeadline: opt(num()),
	retireDeadline: opt(num()),
});
export type WireReloadOptions = Static<typeof WireReloadOptionsSchema>;

/** A child's prepared reload, sent with its vote (same fields as `ReloadReport`, without children). */
const WireReloadReportSchema = Open({
	codeVersion: int(),
	previous: int(),
	changed: List(str()),
	removed: List(str()),
	prepared: List(str()),
	gated: List(str()),
});
export type WireReloadReport = Static<typeof WireReloadReportSchema>;

const FrameSchema = union([
	Open({
		t: lit("hello"),
		/** The link protocol version (`PROTOCOL_VERSION`; absent: 1). Peers of another version close the link. */
		protocol: opt(int({ minimum: 1 })),
		name: Name,
		kind: union([lit("host"), lit("client")]),
		codeVersion: int({ minimum: 0 }),
		/** The sender acknowledges what it receives (`ack`). Flow control applies only when both hellos say so. */
		acks: opt(bool()),
	}),
	/** Every frame received so far except `ack` frames, counted from the link's start, once processed. */
	Open({ t: lit("ack"), n: int({ minimum: 1 }) }),
	Open({
		t: lit("hold"),
		id: Id,
		/**
		 * Target host name, resolved by the consumer from the token's `host` and `input`. Relays route on it after
		 * checking it against both; the target refuses an input its own contract places elsewhere.
		 */
		at: Name,
		/** The consumer's contract token; the provider checks that it covers it. Remote tokens carry `host`. */
		token: DescriptionSchema,
		/** Normalized with the consumer's contract. */
		input: unknown(),
		/** A forwarded principal. Honored only on frames from the parent link. */
		principal: opt(unknown()),
		/**
		 * The client connection the hold comes from: an opaque id the server assigned to it, forwarded by relays. Honored
		 * only on frames from the parent link; present means the hold is a client's (not a reload participant).
		 */
		origin: opt(Name),
		/** False: no state for this hold until `sub` (a method-only binding). */
		state: opt(lit(false)),
		/** The consumer already has values (a re-hold after a link loss): its unit is not urgent. */
		again: opt(lit(true)),
	}),
	Open({ t: lit("release"), id: Id }),
	Open({
		t: lit("shape"),
		id: Id,
		variant: opt(str()),
		members: List(str()),
		contract: str(),
		/** The state members whose snapshots follow this frame; the consumer applies the shape once they are here. */
		state: List(Name),
	}),
	Open({ t: lit("gone"), id: Id, error: WireErrorSchema }),
	Open({
		t: lit("call"),
		id: Id,
		hold: Id,
		member: Name,
		args: opt(unknown()),
		/** Absent: the receiving host starts a root (browsers never carry roots). */
		root: opt(RootRefSchema),
	}),
	Open({
		t: lit("result"),
		id: Id,
		value: opt(unknown()),
		error: opt(WireErrorSchema),
	}),
	Open({ t: lit("cancel"), id: Id }),
	/** Starts the state of a hold opened with `state: false` (answered with a unit). */
	Open({ t: lit("sub"), hold: Id }),
	/** Stops the state of a hold. */
	Open({ t: lit("unsub"), hold: Id }),
	/** Sends member `m` again as a reset (a relay that had to drop what waited for it). */
	Open({ t: lit("resync"), hold: Id, m: Name }),
	Open({
		t: lit("state"),
		hold: Id,
		m: Name,
		/** `snap`/`reset` without `value`: the value is `undefined`. */
		as: union([lit("snap"), lit("reset"), lit("ops"), lit("error")]),
		value: opt(unknown()),
		/** Encoded with the stream's delta encoder; the decoder validates each op. */
		ops: opt(List(List(unknown()))),
		error: opt(WireErrorSchema),
	}),
	Open({ t: lit("ping"), n: int() }),
	Open({ t: lit("pong"), n: int() }),
	/** Ends the link (consumed by the link itself). `reason: "protocol-version <n>"`: the sender speaks version n. */
	Open({ t: lit("bye"), reason: opt(str()) }),
	/** The root ended at its origin: its leases on objects end (sent on every link the root's calls used). */
	Open({ t: lit("root_end"), rootId: Name }),
	Open({ t: lit("invalidate"), pattern: map(unknown()) }),
	Open({
		t: lit("prepare"),
		reload: Reload,
		codeVersion: int({ minimum: 1 }),
		plugins: List(str()),
		options: WireReloadOptionsSchema,
	}),
	Open({
		t: lit("vote"),
		reload: Reload,
		error: opt(WireErrorSchema),
		report: opt(WireReloadReportSchema),
	}),
	Open({ t: lit("commit"), reload: Reload }),
	/** The parent dropped `codeVersion`: roots of it may still come from there no longer. */
	Open({ t: lit("retire"), codeVersion: int({ minimum: 1 }) }),
	Open({ t: lit("abort"), reload: Reload }),
]);
export type Frame = Static<typeof FrameSchema>;

/** A frame that passes validation; anything else is a protocol violation. */
export const isFrame: (value: unknown) => value is Frame = compile(FrameSchema).check;

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
