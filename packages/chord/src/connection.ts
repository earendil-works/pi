import { contractFromDescription, LOCAL_VARIANT, resolveHost } from "./contract.ts";
import { type Encoder, encoder } from "./delta/index.ts";
import { ChordError, invalid } from "./errors.ts";
import type { HostImpl } from "./host.ts";
import { type Link, Packed, unpack } from "./link.ts";
import { type CtxImpl, RefImpl, variantOf } from "./object.ts";
import type { RemoteBinding, RemoteChannel } from "./remote.ts";
import { assertValid } from "./schema.ts";
import type { Ctx, Readable, Shape, StateEvent } from "./types.ts";
import { type Frame, fromWireError, isFrame, PROTOCOL_VERSION, type RootRef, toWireError } from "./wire.ts";

export interface LinkOptions {
	/** Milliseconds between pings (default 15000). */
	readonly pingInterval?: number;
	/** Close the link when nothing arrived for this long (default 45000). Everything held through it is released. */
	readonly pingTimeout?: number;
	/**
	 * Unacknowledged frame bytes (JSON text length) beyond which state frames wait for the peer (default 256 KiB). Only
	 * applies when both ends acknowledge frames and the link reports sizes; `Infinity` never holds state back.
	 */
	readonly window?: number;
	/**
	 * Bytes of state ops that may wait for the peer on this link (default 4 windows). Beyond, the oldest waiting streams
	 * are replaced by their current value (a reset), so memory stays bounded however long the peer stalls.
	 */
	readonly pendingCap?: number;
	/**
	 * The peer speaks another link protocol version (`peer`: undefined if it did not say): the link closes, and should
	 * not be reconnected with the same code. A browser reloads its page, for instance.
	 */
	readonly onProtocolMismatch?: (versions: { readonly local: number; readonly peer: number | undefined }) => void;
}

const DEFAULT_WINDOW = 256 * 1024;
/** The default cap of waiting state ops per link, in windows. */
const PENDING_WINDOWS = 4;

type StateFrame = Extract<Frame, { t: "state" }>;

/**
 * How a waiting stream recovers when its ops must be dropped: the provider resends the current value as a reset at
 * flush; a relay (which has no value) asks downstream for one.
 */
type Overflow = { readonly resend: () => void } | { readonly resync: () => void };

/**
 * What waits on a link. A unit slot is lazy: the shape and snapshots are built from the current values when it is sent.
 * A state slot keeps a snapshot, reset or error (`base`) and encoded ops to apply after it, in order (as they arrived;
 * the receiving decoder validates them), or, once `lazy`, only the promise of a reset built at flush.
 */
type Slot =
	| { readonly kind: "unit"; readonly hold: number; readonly flush: () => void }
	| {
			readonly kind: "state";
			readonly hold: number;
			readonly m: string;
			base: StateFrame | undefined;
			ops: (readonly unknown[])[];
			size: number;
			lazy: boolean;
			readonly overflow: Overflow;
	  };

export interface AcceptOptions<P = unknown> extends LinkOptions {
	/** The principal of whatever connects, from the app's authenticator. Every request on the link acts as it. */
	readonly principal: P;
	/**
	 * What the peer is, decided here and never by its `hello`: `client` (default; a browser: no roots, no code versions,
	 * not a reload participant, not addressable) or `host` (a child host; needs `name`).
	 */
	readonly kind?: "host" | "client";
	/** A child host's name: its hello must match, and it is reachable `at` this name. */
	readonly name?: string;
	/** On `invalidatePrincipal`: a new principal keeps the link, `undefined` closes it (default: close). */
	restamp?(principal: P): P | undefined;
	/**
	 * Calls the peer may have in progress on this link (default: no limit). Further ones never run: they are answered
	 * at once with `unavailable` (reason `too_many_calls`), and the link stays open.
	 */
	readonly maxCalls?: number;
}

export interface Peer {
	readonly kind: "host" | "client";
	/** Configured (downstream hosts) or announced by the trusted parent (upstream). */
	readonly name: string | undefined;
}

/** A state member's stream to the consumer: its subscription and delta encoder. */
interface Feed {
	unsubscribe: () => void;
	encoder: Encoder;
	/** Events that arrived while a unit or reset was being built (replayed after it is sent). */
	buffer: StateEvent<unknown>[] | undefined;
}

/** A hold the peer made on this host and serves locally. */
interface ServedLocal {
	readonly kind: "local";
	readonly id: number;
	readonly ref: RefImpl;
	readonly principal: unknown;
	/** The client connection it comes from (see `Frame` hold `origin`); undefined for a host's own holds. */
	readonly origin: string | undefined;
	/** The consumer wants state (hold without `state: false`, or `sub`). */
	wantsState: boolean;
	/** The consumer had values before (re-hold): its first unit waits for the window like any other. */
	readonly again: boolean;
	/** A unit was sent. */
	unitSent: boolean;
	/** The members whose snapshot the consumer has, with their streams. */
	readonly feeds: Map<string, Feed>;
}

/** A hold the peer made on this host: served locally or relayed to another link. */
type Served = ServedLocal | { readonly kind: "relay"; readonly relay: RelayRef };

type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void };

const unavailable = (message: string): ChordError => new ChordError("unavailable", message);

// ─── relay ───────────────────────────────────────────────────────────────────

/**
 * A hold relayed from an origin link to a downstream link. It owns everything done through it: state and calls queued
 * while the route resolves, and the downstream twins once forwarded. `close` undoes all of it exactly once (cancels
 * calls downstream, drops what waits for the origin, releases the downstream hold, rejects waiters).
 */
export class RelayRef {
	readonly origin: Connection;
	readonly frame: Extract<Frame, { t: "hold" }>;
	readonly principal: unknown;
	/** The client connection the hold comes from (forwarded downstream); undefined for a host's own holds. */
	readonly originTag: string | undefined;
	/** The origin's authorization generation when the hold arrived; a revocation bumps it. */
	readonly generation: number;
	down: Connection | undefined;
	downId = 0;
	closed = false;
	/** The origin wants state (forwarded as `state: false`, `sub`, `unsub`). */
	stateWanted: boolean;
	/** The members of the first unit, still to forward past the origin's window. */
	urgent: Set<string> | undefined;
	#shaped = false;
	/** Members whose ops this relay dropped: downstream ops are ignored until their reset arrives. */
	readonly awaiting = new Set<string>();
	readonly calls = new Map<number, RelayCall>();
	readonly #waiters = new Set<Pending>();

	constructor(
		origin: Connection,
		frame: Extract<Frame, { t: "hold" }>,
		principal: unknown,
		originTag: string | undefined,
	) {
		this.origin = origin;
		this.frame = frame;
		this.principal = principal;
		this.originTag = originTag;
		this.stateWanted = frame.state !== false;
		this.generation = origin.generation;
	}

	get originId(): number {
		return this.frame.id;
	}

	get client(): boolean {
		return this.originTag !== undefined;
	}

	/** Still authorized as it was when it arrived. */
	get current(): boolean {
		return !this.closed && this.origin.open && this.origin.generation === this.generation;
	}

	/** The downstream connection once the route resolved; rejects if the relay closes first. */
	ready(): Promise<Connection> {
		if (this.closed) return Promise.reject(new ChordError("gone", "relayed hold closed"));
		if (this.down !== undefined) return Promise.resolve(this.down);
		return new Promise<Connection>((resolve, reject) => {
			this.#waiters.add({ resolve: resolve as (value: unknown) => void, reject });
		});
	}

	/** Forwards the hold to `down`. */
	open(down: Connection): void {
		if (this.closed) return;
		this.down = down;
		this.downId = down.nextId();
		down.relayedRefs.set(this.downId, this);
		const { at, token, input } = this.frame;
		down.send({
			t: "hold",
			id: this.downId,
			at,
			token,
			input,
			principal: this.principal,
			...(this.originTag === undefined ? {} : { origin: this.originTag }),
			...(this.stateWanted ? {} : { state: false as const }),
			...(this.frame.again === true ? { again: true as const } : {}),
		});
		for (const waiter of this.#waiters) waiter.resolve(down);
		this.#waiters.clear();
	}

	/** The origin starts or stops the hold's state. */
	wantState(wanted: boolean): void {
		if (this.closed || wanted === this.stateWanted) return;
		this.stateWanted = wanted;
		if (!wanted) {
			this.origin.dropHoldState(this.originId);
			this.awaiting.clear();
		}
		this.down?.send({ t: wanted ? "sub" : "unsub", hold: this.downId });
	}

	/**
	 * The origin could not keep up and dropped what waited for member `m` (or asked for it again): ask downstream for a
	 * reset, and ignore its ops until the reset arrives.
	 */
	resync(m: string): void {
		if (this.closed) return;
		this.awaiting.add(m);
		this.down?.send({ t: "resync", hold: this.downId, m });
	}

	/** A shape from downstream: forwarded at once; the members of the first unit then skip the origin's window. */
	shape(frame: Extract<Frame, { t: "shape" }>): void {
		if (this.closed) return;
		if (!this.#shaped) {
			this.#shaped = true;
			if (this.frame.again !== true) this.urgent = new Set(frame.state);
		}
		this.origin.send({ ...frame, id: this.originId });
	}

	/** A state frame from downstream. */
	state(frame: StateFrame): void {
		if (this.closed) return;
		const m = frame.m;
		if (this.awaiting.has(m)) {
			if (frame.as === "ops") return;
			this.awaiting.delete(m);
		}
		const out: StateFrame = { ...frame, hold: this.originId };
		if (this.urgent?.delete(m) === true) {
			this.origin.send(out);
			return;
		}
		this.origin.sendState(out, { resync: () => this.resync(m) });
	}

	/**
	 * Closes the relay. `releaseDown`: the downstream hold is still there (origin released, disconnected, or was
	 * revoked): cancel its calls and release it. `notify`: tell the origin the hold is gone.
	 */
	close(error: unknown, options: { readonly releaseDown: boolean; readonly notify: boolean }): void {
		if (this.closed) return;
		this.closed = true;
		for (const call of [...this.calls.values()]) call.cancel(error, options.releaseDown);
		this.origin.dropHoldState(this.originId);
		if (this.origin.served.get(this.originId)?.kind === "relay") this.origin.served.delete(this.originId);
		if (this.down !== undefined) {
			this.down.relayedRefs.delete(this.downId);
			if (options.releaseDown) this.down.send({ t: "release", id: this.downId });
		}
		for (const waiter of this.#waiters) waiter.reject(error);
		this.#waiters.clear();
		if (options.notify) this.origin.send({ t: "gone", id: this.originId, error: toWireError(error) });
	}
}

/** One relayed call: settles once, by result, cancellation or the relay closing; removes both mappings. */
export class RelayCall {
	readonly relay: RelayRef;
	readonly originId: number;
	readonly downId: number;
	readonly #pending: Pending;
	#settled = false;

	constructor(relay: RelayRef, originId: number, downId: number, pending: Pending) {
		this.relay = relay;
		this.originId = originId;
		this.downId = downId;
		this.#pending = pending;
		relay.calls.set(originId, this);
		relay.down?.relayedCalls.set(downId, this);
	}

	finish(error: unknown, value?: unknown): void {
		if (this.#settled) return;
		this.#settled = true;
		this.relay.calls.delete(this.originId);
		this.relay.down?.relayedCalls.delete(this.downId);
		if (error === undefined) this.#pending.resolve(value);
		else this.#pending.reject(error);
	}

	/** Cancels downstream (when the downstream hold still exists) and settles with `error`. */
	cancel(error: unknown, forward: boolean): void {
		if (this.#settled) return;
		if (forward) this.relay.down?.send({ t: "cancel", id: this.downId });
		this.finish(error);
	}
}

// ─── connection ──────────────────────────────────────────────────────────────

/**
 * One end of a link on a host: consumer of remote references, provider for the peer's holds, and relay.
 *
 * State
 * -----
 *
 * A hold implies the state of its variant (unless it says `state: false`). The provider answers with a unit: the shape,
 * then a snapshot of each state member the consumer does not have yet (`shape.state` lists them), then the members'
 * ops and resets. A reload or a variant change sends another unit with the members that are new; members that left the
 * variant stop. The consumer applies a shape once its snapshots are here (`RemoteBinding`).
 *
 * Flow control
 * ------------
 *
 * Problem: state is pushed as fast as it changes, but a peer may read slowly (a phone behind a relay), and a relay may
 * hide that: Cloudflare forwards to browsers without backpressure. Everything sent then queues in front of the next
 * call result. Example: a browser opens three long transcripts (500 KiB of snapshots each) over a 5 Mbit/s path; a
 * result sent next waits 2.4 s, and the snapshot of a transcript the user already left is still sent in full.
 *
 * Solution: the peer acknowledges what it processed (`ack`, a cumulative frame count), and the sender counts the sizes
 * of the frames not yet acknowledged. While they exceed the window, state waits here in slots, flushed in creation
 * order as acknowledgements come:
 * - a member's stream has one slot: ops are appended (encoded batches of one stream may be concatenated, see
 *   `encoder`), a snapshot, reset or error replaces it;
 * - a hold's unit has one slot, built lazily from the current values when it is sent, so a newer unit merges into it;
 *   while it waits, the members it introduces have no stream yet.
 *
 * The first unit of a hold that is not a re-hold (`again`) is sent at once, past the window: a `get` waits for it, and
 * must not wait behind other holds' state. Results, shapes, gone, reload control and pings are sent at once too: they
 * are bounded by the requests the peer makes. Hence the one ordering exception of a link: while state waits, a result
 * can arrive before state changes made before it. Frames of one stream stay in order.
 *
 * Waiting ops are capped per link (`pendingCap`): beyond, the oldest streams are replaced by their current value (a
 * reset built at flush), or, on a relay, by a reset asked of the provider (`resync`), so memory stays bounded however
 * long the peer stalls. The window bounds what is unacknowledged when a frame is sent, so one frame (a large snapshot)
 * may exceed it. Both hellos must announce `acks`; with an older peer nothing is acknowledged and nothing waits. Links
 * that do not report sizes (IPC) never fill the window.
 */
export class Connection implements RemoteChannel {
	readonly host: HostImpl;
	readonly link: Link;
	/** `upstream`: the link to this host's parent. `downstream`: a link this host accepted. */
	readonly role: "upstream" | "downstream";
	readonly peer: Peer;
	/** A client connection's opaque id: holds that come over it (directly or relayed) carry it as their `origin`. */
	readonly originId: string | undefined;
	principal: unknown;
	readonly restamp: ((principal: unknown) => unknown | undefined) | undefined;
	/** Bumped when the stamped principal is revoked or re-stamped: relays from before are refused. */
	generation = 0;
	/** The code version a downstream host peer runs (from its hello, then from commits). */
	peerCodeVersion: number | undefined;
	/** A downstream host peer is usable once it runs this host's current code version (see `HostImpl.peerHello`). */
	synced: boolean;
	/** Code versions this child announced while behind this host (fenced): this host never ran them. */
	readonly fencedCodeVersions = new Set<number>();
	/** Roots of fenced code versions, by the code version of this host they were admitted in. */
	readonly #admitted = new Map<string, number>();
	#parentName: string | undefined;
	readonly #syncWaiters = new Set<Pending>();
	#nextId = 1;
	#lastSeen = Date.now();
	#pinger: ReturnType<typeof setInterval> | undefined;
	readonly #maxCalls: number;
	// flow control (see the class comment)
	readonly #window: number;
	readonly #pendingCap: number;
	/** Whether the peer acknowledges frames; until its hello is here, frames are counted in case it does. */
	#peerAcks: boolean | undefined;
	#sent = 0;
	#acked = 0;
	/** Sizes of the frames sent after the last acknowledged one. */
	#unacked: number[] = [];
	#unackedBytes = 0;
	readonly #pending = new Map<string, Slot>();
	/** Bytes of ops waiting in `#pending`. */
	#pendingBytes = 0;
	#received = 0;
	#ackTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #onProtocolMismatch: LinkOptions["onProtocolMismatch"];
	/** The peer speaks another protocol version: nothing it sends is processed any more. */
	#mismatched = false;
	// consumer side: what this host asked of the peer
	readonly remotes = new Map<number, RemoteBinding>();
	readonly calls = new Map<number, Pending>();
	// provider side: what the peer asked of this host
	readonly served = new Map<number, Served>();
	readonly incoming = new Map<number, AbortController>();
	// downstream side of relays: ids this host used on this link
	readonly relayedRefs = new Map<number, RelayRef>();
	readonly relayedCalls = new Map<number, RelayCall>();
	/** Reload votes awaited from this (child) peer. */
	readonly votes = new Map<number, Pending>();

	constructor(
		host: HostImpl,
		link: Link,
		config: {
			readonly role: "upstream" | "downstream";
			readonly principal: unknown;
			readonly peer: Peer;
			readonly originId?: string;
			readonly restamp?: (principal: unknown) => unknown | undefined;
			readonly maxCalls?: number;
		} & LinkOptions,
	) {
		this.host = host;
		this.link = link;
		this.role = config.role;
		this.peer = config.peer;
		this.originId = config.originId;
		this.principal = config.principal;
		this.restamp = config.restamp;
		this.synced = !(this.role === "downstream" && this.peer.kind === "host");
		this.#window = config.window ?? DEFAULT_WINDOW;
		this.#pendingCap = config.pendingCap ?? this.#window * PENDING_WINDOWS;
		this.#maxCalls = config.maxCalls ?? Number.POSITIVE_INFINITY;
		this.#onProtocolMismatch = config.onProtocolMismatch;
		link.onClose((reason) => this.#closed(reason));
		link.receive((frame) => this.#receive(frame));
		this.send({
			t: "hello",
			protocol: PROTOCOL_VERSION,
			name: host.name,
			kind: host.kind,
			codeVersion: host.current.id,
			acks: true,
		});
		const interval = config.pingInterval ?? 15_000;
		const timeout = config.pingTimeout ?? 45_000;
		// A link that was already closed closed this connection above; it needs no keepalive.
		if (link.closed) return;
		let n = 0;
		this.#pinger = setInterval(() => {
			if (Date.now() - this.#lastSeen > timeout) link.close("ping timeout");
			else this.send({ t: "ping", n: ++n });
		}, interval);
		this.#pinger.unref?.();
	}

	get open(): boolean {
		return !this.link.closed;
	}

	/** The peer's name: configured for downstream hosts, announced by the parent upstream. */
	get name(): string | undefined {
		return this.role === "upstream" ? this.#parentName : this.peer.name;
	}

	send(frame: Frame): void {
		const size = this.link.send(frame) ?? 0;
		if (this.#peerAcks === false) return;
		this.#sent++;
		this.#unacked.push(size);
		this.#unackedBytes += size;
	}

	/** Sends a state frame, or keeps it waiting (see the class comment). */
	sendState(frame: StateFrame, overflow: Overflow): void {
		const key = stateKey(frame.hold, frame.m);
		let slot = this.#pending.get(key);
		if (slot === undefined && !this.#full) {
			this.send(frame);
			return;
		}
		if (slot?.kind === "unit") return;
		if (slot === undefined) {
			slot = {
				kind: "state",
				hold: frame.hold,
				m: frame.m,
				base: undefined,
				ops: [],
				size: 0,
				lazy: false,
				overflow,
			};
			this.#pending.set(key, slot);
		}
		if (frame.as !== "ops") {
			this.#pendingBytes -= slot.size;
			slot.base = frame;
			slot.ops = [];
			slot.size = 0;
			slot.lazy = false;
			return;
		}
		// A reset built at flush already covers these ops.
		if (slot.lazy) return;
		const size = JSON.stringify(frame.ops).length;
		if (this.#pendingBytes + size > this.#pendingCap) this.#makeRoom(size, slot);
		if (slot.lazy || this.#pending.get(key) !== slot) return;
		for (const op of frame.ops ?? []) slot.ops.push(op);
		slot.size += size;
		this.#pendingBytes += size;
	}

	/** Replaces the oldest waiting streams by resets until `size` more bytes fit; `current` last, if needed. */
	#makeRoom(size: number, current: Extract<Slot, { kind: "state" }>): void {
		for (const slot of [...this.#pending.values()]) {
			if (this.#pendingBytes + size <= this.#pendingCap) return;
			if (slot.kind === "state" && slot !== current && slot.size > 0) this.#drop(slot);
		}
		if (this.#pendingBytes + size > this.#pendingCap) this.#drop(current);
	}

	/** Drops what waits for a stream: a lazy reset replaces it (provider), or the relay asks downstream for one. */
	#drop(slot: Extract<Slot, { kind: "state" }>): void {
		this.#pendingBytes -= slot.size;
		slot.base = undefined;
		slot.ops = [];
		slot.size = 0;
		if ("resend" in slot.overflow) {
			slot.lazy = true;
			return;
		}
		this.#pending.delete(stateKey(slot.hold, slot.m));
		slot.overflow.resync();
	}

	/** Sends member `m` of a served hold again as a reset, through the window (`resync`). */
	#resetLater(hold: number, m: string, resend: () => void): void {
		const key = stateKey(hold, m);
		let slot = this.#pending.get(key);
		if (slot?.kind === "unit") return;
		if (slot === undefined) {
			slot = { kind: "state", hold, m, base: undefined, ops: [], size: 0, lazy: true, overflow: { resend } };
			this.#pending.set(key, slot);
		} else {
			this.#pendingBytes -= slot.size;
			slot.base = undefined;
			slot.ops = [];
			slot.size = 0;
			slot.lazy = true;
		}
		this.#flush();
	}

	/** Queues a hold's lazy unit (a waiting one already covers this one), and sends what the window allows. */
	#queueUnit(hold: number, flush: () => void): void {
		const key = unitKey(hold);
		if (!this.#pending.has(key)) this.#pending.set(key, { kind: "unit", hold, flush });
		this.#flush();
	}

	/** Forgets what waits for a stream that ended. */
	dropState(hold: number, m: string): void {
		const slot = this.#pending.get(stateKey(hold, m));
		if (slot?.kind !== "state") return;
		this.#pendingBytes -= slot.size;
		this.#pending.delete(stateKey(hold, m));
	}

	/** Forgets everything that waits for a hold (released, closed, or its state stopped). */
	dropHoldState(hold: number): void {
		for (const [key, slot] of this.#pending) {
			if (slot.hold !== hold) continue;
			if (slot.kind === "state") this.#pendingBytes -= slot.size;
			this.#pending.delete(key);
		}
	}

	/** What waits for the peer: slots and bytes of ops (for tests and diagnostics). */
	get waiting(): { readonly slots: number; readonly bytes: number } {
		return { slots: this.#pending.size, bytes: this.#pendingBytes };
	}

	get #full(): boolean {
		return this.#peerAcks === true && this.#unackedBytes >= this.#window;
	}

	#onAck(n: number): void {
		if (this.#peerAcks !== true || n < this.#acked || n > this.#sent) {
			this.#violation(`ack ${n} outside ${this.#acked}..${this.#sent}`);
			return;
		}
		for (const size of this.#unacked.splice(0, n - this.#acked)) this.#unackedBytes -= size;
		this.#acked = n;
		this.#flush();
	}

	/** Sends waiting slots in creation order while the window allows. */
	#flush(): void {
		for (const [key, slot] of this.#pending) {
			if (this.#full) return;
			this.#pending.delete(key);
			if (slot.kind === "unit") {
				slot.flush();
				continue;
			}
			this.#pendingBytes -= slot.size;
			if (slot.lazy) {
				if ("resend" in slot.overflow) slot.overflow.resend();
				continue;
			}
			if (slot.base !== undefined) this.send(slot.base);
			if (slot.ops.length > 0) this.send({ t: "state", hold: slot.hold, m: slot.m, as: "ops", ops: slot.ops });
		}
	}

	/** Acknowledges once the frames that arrived together are processed: one ack per burst, not per frame. */
	#scheduleAck(): void {
		if (this.#peerAcks !== true || this.#ackTimer !== undefined || !this.open) return;
		this.#ackTimer = setTimeout(() => {
			this.#ackTimer = undefined;
			this.link.send({ t: "ack", n: this.#received });
		}, 0);
		this.#ackTimer.unref?.();
	}

	nextId(): number {
		return this.#nextId++;
	}

	/** Resolves once the peer is usable (a host peer runs this host's code version); rejects if the link closes first. */
	whenSynced(): Promise<void> {
		if (!this.open) return Promise.reject(unavailable(`link to ${this.name ?? "peer"} closed`));
		if (this.synced) return Promise.resolve();
		return new Promise<void>((resolve, reject) => this.#syncWaiters.add({ resolve: resolve as () => void, reject }));
	}

	markSynced(codeVersion: number): void {
		this.peerCodeVersion = codeVersion;
		this.synced = true;
		for (const waiter of this.#syncWaiters) waiter.resolve(undefined);
		this.#syncWaiters.clear();
	}

	/** Revokes the stamped principal: relays made under it close at once (also those still resolving a route). */
	revoke(next: unknown | undefined): void {
		this.generation++;
		const error = new ChordError("gone", "principal invalidated");
		for (const served of [...this.served.values()]) {
			if (served.kind === "relay") served.relay.close(error, { releaseDown: true, notify: true });
		}
		if (next === undefined) this.link.close("principal invalidated");
		else this.principal = next;
	}

	/**
	 * Stops talking to a peer of another protocol version: reports it and closes the link. The close reason tells the
	 * peer this side's version (`protocol-version <n>`); a peer that noticed first told us the same way (`#closed`).
	 */
	#protocolMismatch(peer: number | undefined, close = true): void {
		if (this.#mismatched) return;
		this.#mismatched = true;
		try {
			this.#onProtocolMismatch?.({ local: PROTOCOL_VERSION, peer });
		} catch (error) {
			this.host.report(error);
		}
		if (close) this.link.close(`protocol-version ${PROTOCOL_VERSION}`);
	}

	/** A protocol violation: the peer cannot be trusted with anything on this link any more. */
	#violation(reason: string): void {
		this.host.report(new ChordError("invalid", `link to ${this.name ?? "peer"}: ${reason}`, { reason: "protocol" }));
		this.link.close(`protocol error: ${reason}`);
	}

	// ─── consumer side (RemoteChannel) ───

	hold(binding: RemoteBinding, again: boolean): number {
		const id = this.nextId();
		this.remotes.set(id, binding);
		binding.bound(this, id);
		const principal = binding.principal;
		this.send({
			t: "hold",
			id,
			at: binding.at,
			token: binding.contract.description,
			input: binding.input,
			...(principal === undefined ? {} : { principal }),
			...(binding.stateOn ? {} : { state: false as const }),
			...(again ? { again: true as const } : {}),
		});
		return id;
	}

	release(id: number): void {
		this.remotes.delete(id);
		this.send({ t: "release", id });
	}

	wantState(hold: number, wanted: boolean): void {
		if (this.remotes.has(hold)) this.send({ t: wanted ? "sub" : "unsub", hold });
	}

	call(hold: number, member: string, args: unknown, root: RootRef | undefined, signal: AbortSignal): Promise<unknown> {
		const id = this.nextId();
		return new Promise<unknown>((resolve, reject) => {
			if (signal.aborted) {
				reject(new ChordError("aborted", "call aborted"));
				return;
			}
			const onAbort = (): void => {
				this.calls.delete(id);
				this.send({ t: "cancel", id });
				reject(new ChordError("aborted", "call aborted", { cause: signal.reason }));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const done = (): void => signal.removeEventListener("abort", onAbort);
			this.calls.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
			});
			// Clients never carry roots or code versions: the server starts roots for them.
			const carried = root !== undefined && this.host.kind === "host";
			if (carried) this.host.rootSent(root.rootId, this);
			this.send({ t: "call", id, hold, member, args, ...(carried ? { root } : {}) });
		});
	}

	// ─── receiving ───

	#receive(frame: unknown): void {
		if (this.#mismatched) return;
		this.#lastSeen = Date.now();
		if (!isFrame(frame)) {
			this.#violation("malformed frame");
			return;
		}
		if (frame.t === "ack") {
			this.#onAck(frame.n);
			return;
		}
		this.#received++;
		try {
			this.#dispatch(frame);
		} catch (error) {
			this.host.report(error);
		}
		this.#scheduleAck();
	}

	#dispatch(frame: Frame): void {
		switch (frame.t) {
			case "hello":
				this.#onHello(frame);
				return;
			case "ping":
				this.send({ t: "pong", n: frame.n });
				return;
			case "pong":
			case "bye":
			case "ack":
				return;
			case "hold":
				this.#onHold(frame);
				return;
			case "release":
				this.#dropServed(frame.id, true);
				return;
			case "call":
				this.#onCall(frame);
				return;
			case "cancel":
				this.incoming.get(frame.id)?.abort(new ChordError("aborted", "cancelled by caller"));
				return;
			case "sub":
			case "unsub":
				this.#onWantState(frame.hold, frame.t === "sub");
				return;
			case "resync":
				this.#onResync(frame.hold, frame.m);
				return;
			case "shape":
			case "gone":
				this.#onHoldReply(frame);
				return;
			case "result":
				this.#onResult(frame);
				return;
			case "state":
				this.#onState(frame);
				return;
			case "root_end":
				// Honored only from the link the root came over (see HostImpl.foreignRootEnded).
				this.#admitted.delete(frame.rootId);
				this.host.foreignRootEnded(frame.rootId, this);
				return;
			case "invalidate":
			case "prepare":
			case "commit":
			case "abort":
			case "retire":
				// Control frames only from the parent.
				if (this.role !== "upstream") {
					this.#violation(`${frame.t} from a child`);
					return;
				}
				if (frame.t === "invalidate") {
					this.host.invalidatePrincipal(frame.pattern).catch((error: unknown) => this.host.report(error));
				} else if (frame.t === "retire") this.host.allowRetire(frame.codeVersion);
				else this.host.onReloadFrame(this, frame);
				return;
			case "vote": {
				if (this.role !== "downstream" || this.peer.kind !== "host") {
					this.#violation("vote from a non-participant");
					return;
				}
				const vote = this.votes.get(frame.reload);
				this.votes.delete(frame.reload);
				if (frame.error === undefined) vote?.resolve(frame.report);
				else vote?.reject(fromWireError(frame.error));
				return;
			}
		}
	}

	/**
	 * The peer's hello must agree with what this side decided about it. A downstream host announces its code version:
	 * the host either finds it in step or fences and reconciles it (never renumbers).
	 */
	#onHello(frame: Extract<Frame, { t: "hello" }>): void {
		if ((frame.protocol ?? 1) !== PROTOCOL_VERSION) {
			this.#protocolMismatch(frame.protocol ?? 1);
			return;
		}
		if (this.#peerAcks === undefined) {
			this.#peerAcks = frame.acks === true;
			if (!this.#peerAcks) {
				this.#unacked = [];
				this.#unackedBytes = 0;
			}
		}
		if (this.role === "upstream") {
			if (frame.kind !== "host") {
				this.#violation("parent is not a host");
				return;
			}
			this.#parentName ??= frame.name;
			return;
		}
		if (frame.kind !== this.peer.kind || (this.peer.name !== undefined && frame.name !== this.peer.name)) {
			this.#violation(
				`hello ${frame.kind} ${frame.name} does not match the accepted ${this.peer.kind} ${this.peer.name ?? ""}`,
			);
			return;
		}
		if (this.peer.kind === "host") this.host.peerHello(this, frame.codeVersion);
	}

	/**
	 * Principal stamping: a downstream link acts as the principal it was accepted with, whatever the frame says. Only
	 * the parent may forward a principal (relayed requests); its own requests act as the principal given to `connect`.
	 */
	#principalOf(frame: { readonly principal?: unknown }): unknown {
		if (this.role === "downstream") return this.principal;
		return frame.principal ?? this.principal;
	}

	/**
	 * The client connection a hold comes from: this link's own id for a client link (whatever the frame says), the id
	 * the parent forwarded for a relayed hold, none for a host's own holds.
	 */
	#originOf(frame: { readonly origin?: string }): string | undefined {
		return this.role === "downstream" ? this.originId : frame.origin;
	}

	#onHold(frame: Extract<Frame, { t: "hold" }>): void {
		if (this.served.has(frame.id)) {
			this.#violation(`duplicate hold id ${frame.id}`);
			return;
		}
		const principal = this.#principalOf(frame);
		const origin = this.#originOf(frame);
		const client = origin !== undefined;
		if (frame.at !== this.host.name) {
			if (this.role === "upstream") {
				this.send({ t: "gone", id: frame.id, error: toWireError(unavailable(`${this.host.name} does not relay`)) });
				return;
			}
			const relay = new RelayRef(this, frame, principal, origin);
			this.served.set(frame.id, { kind: "relay", relay });
			this.host.relay(relay).catch((error: unknown) => relay.close(error, { releaseDown: true, notify: true }));
			return;
		}
		let ref: RefImpl;
		try {
			const token = contractFromDescription(frame.token);
			if (token.scope !== "remote") throw invalid("token", `${token.name} is local; only remote types cross links`);
			// Addressed here, so the input must place it here (also by this host's contract, checked when acquiring).
			if (resolveHost(token.name, token.description.host!, frame.input) !== this.host.name)
				throw invalid("placement", `${token.name} with this input does not live on ${this.host.name}`);
			const acquired = this.host.acquire(token, frame.input, { principal }, client ? "client" : "connection");
			if (!(acquired instanceof RefImpl)) throw unavailable("not a local reference");
			ref = acquired;
		} catch (error) {
			this.send({ t: "gone", id: frame.id, error: toWireError(client ? clientError(error) : error) });
			return;
		}
		const served: ServedLocal = {
			kind: "local",
			id: frame.id,
			ref,
			principal,
			origin,
			wantsState: frame.state !== false,
			again: frame.again === true,
			unitSent: false,
			feeds: new Map(),
		};
		this.served.set(frame.id, served);
		ref.onShape(() => this.#unit(served));
		ref.goneListeners.add((error) => {
			if (this.served.get(frame.id) !== served) return;
			this.#dropServed(frame.id, false);
			this.send({ t: "gone", id: frame.id, error: toWireError(error) });
		});
		if (ref.status === "live") this.#unit(served);
	}

	/** The state members of `shape` the consumer's contract knows. */
	#stateMembers(ref: RefImpl, shape: Shape): string[] {
		return shape.members.filter((name) => ref.describe(shape.variant, name)?.kind === "state");
	}

	/**
	 * The shape changed (live, reload, variant) or state was asked for: members that left lose their stream, and a unit
	 * goes out with the shape and the members the consumer lacks. The first unit of a hold (not a re-hold) is urgent.
	 */
	#unit(served: ServedLocal): void {
		if (this.served.get(served.id) !== served) return;
		const shape = served.ref.shape;
		if (shape === undefined) return;
		const members = new Set(served.wantsState ? this.#stateMembers(served.ref, shape) : []);
		for (const [name, feed] of served.feeds) {
			if (members.has(name)) continue;
			feed.unsubscribe();
			served.feeds.delete(name);
			this.dropState(served.id, name);
		}
		const urgent = served.feeds.size === 0 && !(served.again && !served.unitSent);
		if (urgent) this.#sendUnit(served);
		else this.#queueUnit(served.id, () => this.#sendUnit(served));
	}

	/** Builds and sends a unit from the current shape and values. */
	#sendUnit(served: ServedLocal): void {
		this.#pending.delete(unitKey(served.id));
		if (this.served.get(served.id) !== served) return;
		const shape = served.ref.shape;
		if (shape === undefined) return;
		served.unitSent = true;
		const members = served.wantsState ? this.#stateMembers(served.ref, shape) : [];
		const listed = members.filter((name) => !served.feeds.has(name));
		const snaps: StateFrame[] = [];
		const attached: (readonly [string, Feed])[] = [];
		for (const name of listed) {
			const attachment = this.#attach(served, name);
			if (attachment === undefined) continue;
			snaps.push(attachment.frame);
			attached.push([name, attachment.feed]);
		}
		this.send({
			t: "shape",
			id: served.id,
			...(shape.variant === undefined ? {} : { variant: shape.variant }),
			members: shape.members,
			contract: shape.contract,
			state: snaps.map((frame) => frame.m),
		});
		for (const frame of snaps) this.send(frame);
		for (const [name, feed] of attached) this.#replay(served, name, feed);
	}

	/**
	 * Subscribes member `name` for the consumer: its snapshot (as a frame of type `as`), and a feed whose later events
	 * wait in its buffer until the snapshot is sent (`#replay`). Undefined if the member is not readable state.
	 */
	#attach(
		served: ServedLocal,
		name: string,
		as: "snap" | "reset" = "snap",
	): { readonly frame: StateFrame; readonly feed: Feed } | undefined {
		const readable = served.ref.member(name) as Readable<unknown> | undefined;
		if (readable === undefined || typeof readable.events !== "function") return undefined;
		const feed: Feed = { unsubscribe: () => {}, encoder: encoder(), buffer: [] };
		let first: StateEvent<unknown> | undefined;
		feed.unsubscribe = readable.events((event) => {
			if (first === undefined) first = event;
			else if (feed.buffer !== undefined) feed.buffer.push(event);
			else this.#feedEvent(served, name, feed, event);
		});
		served.feeds.set(name, feed);
		return { frame: this.#snapshot(served, name, as, first?.value), feed };
	}

	/** Sends the events that arrived while the snapshot was built, now that it is sent. */
	#replay(served: ServedLocal, name: string, feed: Feed): void {
		const buffered = feed.buffer ?? [];
		feed.buffer = undefined;
		for (const event of buffered) this.#feedEvent(served, name, feed, event);
	}

	/** A member's state frame for a snapshot or reset: validated against the schema the consumer is promised. */
	#snapshot(served: ServedLocal, name: string, as: "snap" | "reset", value: unknown): StateFrame {
		try {
			validateSnapshot(served.ref, name, value);
		} catch (error) {
			return { t: "state", hold: served.id, m: name, as: "error", error: toWireError(error) };
		}
		return { t: "state", hold: served.id, m: name, as, ...(value === undefined ? {} : { value }) };
	}

	/** A later event of a member's stream: ops are encoded, a reset starts a new stream. */
	#feedEvent(served: ServedLocal, name: string, feed: Feed, event: StateEvent<unknown>): void {
		if (served.feeds.get(name) !== feed) return;
		const overflow = { resend: () => this.#resend(served, name) };
		if (event.type === "ops") {
			this.sendState(
				{ t: "state", hold: served.id, m: name, as: "ops", ops: feed.encoder.encode(event.ops) },
				overflow,
			);
			return;
		}
		feed.encoder = encoder();
		this.sendState(this.#snapshot(served, name, "reset", event.value), overflow);
	}

	/** Sends member `name` again, now, as a reset from its current value (a lazy slot is flushed, or `resync`). */
	#resend(served: ServedLocal, name: string): void {
		const feed = served.feeds.get(name);
		if (feed === undefined || this.served.get(served.id) !== served) return;
		feed.unsubscribe();
		served.feeds.delete(name);
		const attachment = this.#attach(served, name, "reset");
		if (attachment === undefined) return;
		this.send(attachment.frame);
		this.#replay(served, name, attachment.feed);
	}

	/** The consumer starts (`sub`) or stops (`unsub`) the state of a hold. */
	#onWantState(hold: number, wanted: boolean): void {
		const served = this.served.get(hold);
		if (served === undefined) return;
		if (served.kind === "relay") {
			served.relay.wantState(wanted);
			return;
		}
		if (served.wantsState === wanted) return;
		served.wantsState = wanted;
		if (wanted) {
			this.#unit(served);
			return;
		}
		for (const feed of served.feeds.values()) feed.unsubscribe();
		served.feeds.clear();
		this.dropHoldState(hold);
	}

	/** The consumer (a relay that dropped ops) asks for member `m` again as a reset. */
	#onResync(hold: number, m: string): void {
		const served = this.served.get(hold);
		if (served === undefined) return;
		if (served.kind === "relay") {
			served.relay.resync(m);
			return;
		}
		if (!served.feeds.has(m)) return;
		this.#resetLater(hold, m, () => this.#resend(served, m));
	}

	/** Forgets a served hold: unsubscribes its feeds and releases it (locally or downstream). */
	#dropServed(id: number, release: boolean): void {
		const served = this.served.get(id);
		if (served === undefined) return;
		this.served.delete(id);
		if (served.kind === "relay") {
			served.relay.close(new ChordError("released", "relayed hold released"), {
				releaseDown: release,
				notify: false,
			});
			return;
		}
		for (const feed of served.feeds.values()) feed.unsubscribe();
		served.feeds.clear();
		this.dropHoldState(id);
		if (release) served.ref.release();
	}

	#onCall(frame: Extract<Frame, { t: "call" }>): void {
		if (this.incoming.has(frame.id)) {
			this.#violation(`duplicate call id ${frame.id}`);
			return;
		}
		if (this.incoming.size >= this.#maxCalls) {
			const error = new ChordError(
				"unavailable",
				`Too many calls in progress on this connection (${this.#maxCalls}); wait for earlier ones to finish`,
				{ reason: "too_many_calls" },
			);
			this.send({ t: "result", id: frame.id, error: toWireError(error) });
			return;
		}
		const served = this.served.get(frame.hold);
		if (served === undefined) {
			this.send({ t: "result", id: frame.id, error: toWireError(new ChordError("gone", "unknown hold")) });
			return;
		}
		const controller = new AbortController();
		this.incoming.set(frame.id, controller);
		// Roots are honored from hosts only; a request without one (or from a client) starts one here.
		const root = this.peer.kind === "host" ? this.#admitRoot(frame.root) : undefined;
		const principal = served.kind === "local" ? served.principal : served.relay.principal;
		const options = { principal, signal: controller.signal };
		const run =
			served.kind === "local"
				? (ctx: Ctx) => served.ref.object.call(served.ref, frame.member, unpack(frame.args), ctx as CtxImpl)
				: (ctx: Ctx) =>
						relayCall(
							served.relay,
							frame,
							{ rootId: ctx.rootId, codeVersion: ctx.codeVersion },
							// The root's signal: a cancel from the origin and the root's code version retiring both reach it.
							ctx.signal,
							this.host,
						);
		const result =
			root === undefined
				? this.host.root(run, options)
				: this.host.joinRoot(root.rootId, root.codeVersion, run, { ...options, from: this });
		result
			.then(
				(value) => this.send({ t: "result", id: frame.id, value }),
				(error: unknown) => this.send({ t: "result", id: frame.id, error: toWireError(error) }),
			)
			.finally(() => this.incoming.delete(frame.id));
	}

	/**
	 * A child that connected behind this host runs roots of a code version this host never had (it was fenced and is
	 * being, or was, reconciled). Such a root is admitted in this host's current code version at its first call here,
	 * and keeps that code version for its later calls (`superseded` once this host retired it). Other unknown code
	 * versions stay `superseded`.
	 */
	#admitRoot(root: RootRef | undefined): RootRef | undefined {
		if (root === undefined || this.role !== "downstream" || !this.fencedCodeVersions.has(root.codeVersion))
			return root;
		if (this.host.hasCodeVersion(root.codeVersion)) return root;
		let codeVersion = this.#admitted.get(root.rootId);
		if (codeVersion === undefined) {
			codeVersion = this.host.current.id;
			this.#admitted.set(root.rootId, codeVersion);
		}
		return { rootId: root.rootId, codeVersion };
	}

	#onHoldReply(frame: Extract<Frame, { t: "shape" | "gone" }>): void {
		const relay = this.relayedRefs.get(frame.id);
		if (relay !== undefined) {
			if (frame.t === "gone") relay.close(fromWireError(frame.error), { releaseDown: false, notify: true });
			else relay.shape(frame);
			return;
		}
		const binding = this.remotes.get(frame.id);
		if (binding === undefined) return;
		if (frame.t === "gone") {
			this.remotes.delete(frame.id);
			binding.gone(fromWireError(frame.error));
			return;
		}
		binding.shaped({ variant: frame.variant, members: frame.members, contract: frame.contract }, frame.state);
	}

	#onResult(frame: Extract<Frame, { t: "result" }>): void {
		const relayed = this.relayedCalls.get(frame.id);
		if (relayed !== undefined) {
			relayed.finish(frame.error === undefined ? undefined : fromWireError(frame.error), frame.value);
			return;
		}
		const pending = this.calls.get(frame.id);
		this.calls.delete(frame.id);
		if (frame.error !== undefined) {
			pending?.reject(fromWireError(frame.error));
			return;
		}
		let value: unknown;
		try {
			value = unpack(frame.value);
		} catch (error) {
			pending?.reject(error);
			return;
		}
		pending?.resolve(value);
	}

	#onState(frame: StateFrame): void {
		const relay = this.relayedRefs.get(frame.hold);
		if (relay !== undefined) {
			relay.state(frame);
			return;
		}
		const binding = this.remotes.get(frame.hold);
		if (binding === undefined) return;
		if (!(frame.value instanceof Packed)) {
			binding.state(frame.m, frame);
			return;
		}
		let value: unknown;
		try {
			value = unpack(frame.value);
		} catch (error) {
			binding.state(frame.m, { as: "error", error: toWireError(error) });
			return;
		}
		binding.state(frame.m, { ...frame, value });
	}

	// ─── lifetime ───

	#closed(reason: string): void {
		const told = /^protocol-version (\d+)$/.exec(reason);
		if (told !== null && Number(told[1]) !== PROTOCOL_VERSION) this.#protocolMismatch(Number(told[1]), false);
		if (this.#pinger !== undefined) clearInterval(this.#pinger);
		if (this.#ackTimer !== undefined) clearTimeout(this.#ackTimer);
		this.#pending.clear();
		this.#pendingBytes = 0;
		const error = unavailable(`link to ${this.name ?? "peer"} closed: ${reason}`);
		// As origin: everything the peer held here, relayed or not, is released (downstream calls cancelled).
		for (const id of [...this.served.keys()]) this.#dropServed(id, true);
		for (const controller of this.incoming.values()) controller.abort(error);
		this.incoming.clear();
		for (const pending of this.calls.values()) pending.reject(error);
		this.calls.clear();
		for (const vote of this.votes.values()) vote.reject(error);
		this.votes.clear();
		for (const waiter of this.#syncWaiters) waiter.reject(error);
		this.#syncWaiters.clear();
		// As downstream of relays: their origins lose the hold.
		for (const relay of [...this.relayedRefs.values()]) relay.close(error, { releaseDown: false, notify: true });
		this.relayedRefs.clear();
		this.relayedCalls.clear();
		const bindings = [...this.remotes.values()];
		this.remotes.clear();
		for (const binding of bindings) {
			// An upstream link may be replaced (reconnect); a downstream host that went away is gone.
			if (this.role === "upstream") binding.detached();
			else binding.gone(error);
		}
		this.host.connectionClosed(this);
	}
}

const stateKey = (hold: number, m: string): string => `s${hold}\u0000${m}`;
const unitKey = (hold: number): string => `u${hold}`;

/**
 * A call through a relay: waits for the route, then forwards with the root it runs in. It settles exactly once; a
 * cancel (or the origin going away) is forwarded downstream and removes both mappings.
 */
async function relayCall(
	relay: RelayRef,
	frame: Extract<Frame, { t: "call" }>,
	root: RootRef,
	signal: AbortSignal,
	host: HostImpl,
): Promise<unknown> {
	const abortError = (): ChordError => new ChordError("aborted", "call cancelled", { cause: signal.reason });
	if (signal.aborted) throw abortError();
	let onAbort = (): void => {};
	let onCancel = (): void => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	aborted.catch(() => {});
	try {
		const down = await Promise.race([relay.ready(), aborted]);
		if (relay.closed) throw new ChordError("gone", "relayed hold closed");
		return await new Promise<unknown>((resolve, reject) => {
			const call = new RelayCall(relay, frame.id, down.nextId(), { resolve, reject });
			onCancel = () => call.cancel(abortError(), true);
			signal.addEventListener("abort", onCancel, { once: true });
			host.rootSent(root.rootId, down);
			down.send({ t: "call", id: call.downId, hold: relay.downId, member: frame.member, args: frame.args, root });
		});
	} finally {
		signal.removeEventListener("abort", onAbort);
		signal.removeEventListener("abort", onCancel);
	}
}

/**
 * Validates a snapshot against the schema the consumer is promised: the provider's own schema for a direct binding,
 * the consumer's contract for one through an `accepts` adapter (the adapter's view is what the consumer gets).
 */
function validateSnapshot(ref: RefImpl, member: string, value: unknown): void {
	if (value === undefined) return;
	const installed = ref.object.currentInstalled();
	if (installed === undefined) return;
	const view = ref.currentView();
	const variant = view === undefined ? variantOf(installed.implementation) : variantOf(view);
	const description =
		view !== undefined && view !== installed.implementation
			? ref.contract.description.variants[variant ?? LOCAL_VARIANT]?.[member]
			: installed.service.contract.description.variants[variantOf(installed.implementation) ?? LOCAL_VARIANT]?.[
					member
				];
	if (description?.kind === "state") assertValid("state", `${ref.address}.${member}`, description.schema, value);
}

/** Clients (browsers) holding an outdated contract are told to reload their code. */
function clientError(error: unknown): unknown {
	if (error instanceof ChordError && error.code === "contract_mismatch") {
		return new ChordError("upgrade_required", error.message, { cause: error });
	}
	return error;
}
