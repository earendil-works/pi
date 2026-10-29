// A hold arriving on a link and served here (§7, §22, W1): where it goes once the host published (waiting in the
// unbound index until then), why it is unbound (refused: kept in the index while it waits for a name, dependency
// model §1), the object it keeps, the notices of its object's failures and new attempts, the snapshot and subscription
// taken in one synchronous step when a slot of the window is free, and the ops of its members per batch (sent at
// once, or pending while the window is full), each member with its own Delta encoder.

import type { Context } from "../../context/index.ts";
import { type Encoder, encoder, type Op, PendingOps } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	currentVariants,
	type VariantData,
	type VariantNames,
	variantNames,
	variantOrder,
} from "../contracts/internal.ts";
import { type ChordError, type FailureCause, isChordError, type Principal } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import {
	type Caller,
	type ChordObject,
	type Holder,
	retryOperation,
	type Serving,
	type UnboundRequest,
} from "../host/internal.ts";
import {
	type BoundEntry,
	type FailedMember,
	jsonPart,
	type Limits,
	type Message,
	NO_RETIRED,
	oversized,
	parsePart,
	type StateEntry,
	wireError,
} from "../link/internal.ts";
import { Source, type Subscriber } from "../state/internal.ts";
import type { HostLink } from "./host-link.ts";
import type { ProviderSide } from "./provider.ts";
import { RelayedHold } from "./relay.ts";

/** A `hold` message. */
type HoldMessage = Extract<Message, { readonly kind: "hold" }>;

/**
 * What a `hold` message asks for. Whom it acts for is not part of it: a host takes that from the message once, as its
 * link allows (`ProviderSide`), and names it again only on a route link (`actingFor`). Its `chain` and `limit` are the
 * ones this host honours, sent on as they are when it relays the hold.
 */
export type HoldRequest = Omit<HoldMessage, "kind" | "origin" | "hold" | "principal" | "incarnation">;

/**
 * A state member a bound hold follows: its index in the bound version, its source and subscription (which feeds this
 * record), its own encoder (R1, path interning) and the ops waiting for a slot of the window.
 */
type Followed = {
	readonly index: number;
	readonly source: Source;
	readonly subscriber: Subscriber;
	readonly encoder: Encoder;
	readonly pending: PendingOps;
};

/**
 * Where a hold stands: `unplaced` in the unbound index until the host's publication places it; `pending` until its
 * object is live (the activation, parking and retries; `toldFailed` once the consumer was told of a failure, so the
 * next attempt is announced with `loading`); `binding` while its object is live and its `bound` waits for a slot;
 * `bound` with the object's variant and the members it follows.
 */
type HoldState =
	| { readonly kind: "unplaced"; readonly request: HoldRequest }
	| { readonly kind: "pending"; readonly toldFailed: boolean }
	| { readonly kind: "binding" }
	| {
			readonly kind: "bound";
			readonly variant: VariantData;
			/** The bound version's names of the variant, which the wire's indexes point into. */
			readonly names: VariantNames;
			/** The members it follows, in the order they were subscribed. */
			readonly followed: Followed[];
	  }
	/**
	 * Refused where it arrived, with `cause`: `waiting` (not served here, another version, placed elsewhere by the
	 * provider's code) in the unbound index until a publication wakes it; `broken` (invalid params, a cycle, a route that
	 * refused, a part past the limits) until a `retry` restarts it.
	 */
	| { readonly kind: "refused"; readonly request: HoldRequest; readonly cause: FailureCause }
	| { readonly kind: "released" };

/** A bound hold's state. */
type Bound = Extract<HoldState, { readonly kind: "bound" }>;

const PENDING: HoldState = { kind: "pending", toldFailed: false };

const BINDING: HoldState = { kind: "binding" };

/**
 * One hold served here: a reference to its object acting as its caller (the hold's principal). While pending, each
 * failure of its object is sent as `failed` (with the rest of its backoff window) and the next attempt as `loading`; a
 * hold that cannot be taken holds nothing: `failed { waiting }` (not served, another version) until a publication
 * re-runs its start, `failed { broken }` (invalid params, a cycle) until a `retry` does. Once live it binds when its
 * link's window has a slot, then sends a part per batch that changed its members (or keeps their ops pending while the
 * window is full), and `gone` when its object ends. It counts as one of the host's references from its arrival to its
 * end, bound or not.
 */
export class Hold implements Holder, UnboundRequest {
	readonly kind = "served";
	readonly id: number;
	/** A hold is declared by no object on this host. */
	readonly dependent = undefined;
	/** Whom the hold acts for: its calls run as it, with its origin's incarnation. */
	readonly caller: Caller;
	/** The limits per part of its params and its calls' arguments: its link's, the decoded one smaller when stamped (Q2). */
	readonly limits: Limits;
	readonly #provider: ProviderSide;
	#state: HoldState = PENDING;
	/** The held object, from its binding until the hold is released. */
	#object: ChordObject | undefined;
	/** The members the current batch changed, with their ops, in order. */
	#changes: (readonly [Followed, readonly Op[]])[] = [];
	/** The members that failed since the last message that carried this hold. */
	#failed: FailedMember[] = [];
	/** The members whose document was retired since the last message that carried this hold (ORed while it waits). */
	#retired: readonly number[] = NO_RETIRED;
	#touched = false;
	/** Whether the hold counts as one of the host's references (`host.activity`): from its arrival until it ends. */
	#counted = true;

	constructor(id: number, provider: ProviderSide, caller: Caller, limits: Limits) {
		this.id = id;
		this.#provider = provider;
		this.caller = caller;
		this.limits = limits;
		provider.link.host.count("references", 1);
	}

	/** Whether the hold is live: calls on it reach its object. */
	get bound(): boolean {
		return this.#state.kind === "bound";
	}

	/** Whom it acts for (the unbound index's revocation). */
	get principal(): Principal | undefined {
		return this.caller.principal;
	}

	/** Whether the hold holds no object: before the publication, or refused (revocation ends it, §4). */
	get unbound(): boolean {
		return this.#object === undefined && this.#state.kind !== "released";
	}

	/**
	 * Admits the hold: before the host's publication it waits in the unbound index, placed by the publication.
	 * Then its params within the link's part limit (`too_large/part`), then relayed (it is replaced by a relayed hold),
	 * or served here, its params opened and parsed (a malformed part is a protocol error), its object taken and followed
	 * (`moved`) in the turn it arrived. A hold that cannot be served here waits refused (`#refuse`).
	 */
	start(request: HoldRequest): void {
		const { link } = this.#provider;
		if (!link.host.published) {
			this.#state = { kind: "unplaced", request: owned(request) };
			link.host.index(request.type, this);
			return;
		}
		let served: Serving;
		try {
			const oversize = oversized(request.params, link.limits.part);
			if (oversize !== undefined) throw oversize;
			const placed = link.host.place(request, link, this.caller, link.context);
			if (placed.kind === "path") {
				// Counted where it is served: a relayed hold is not this host's reference.
				this.drop();
				new RelayedHold(this.id, this.#provider, request, this.caller, placed.path).start();
				return;
			}
			let params: unknown;
			try {
				params = parsePart(link.openPart(request.params, this.limits, link.context));
			} catch (error) {
				// Past its limits: the hold's \`too_large/part\`. No JSON: a protocol error, reported, and the link closes.
				if (isChordError(error, "too_large")) throw error;
				link.host.report({ kind: "protocol_error", error });
				link.close();
				return;
			}
			served = link.host.serving(request, params, this.caller.principal!, link.context);
		} catch (error) {
			this.#refuse(request, { kind: "broken", error: asChordError(error, request.type) });
			return;
		}
		if (served.kind === "waiting") {
			this.#refuse(request, served.cause);
			return;
		}
		const { object } = served;
		this.#object = object;
		object.hold(this);
		this.moved();
	}

	/**
	 * Woken by the unbound index (out of it already): before the publication, placed now; refused `waiting`, its start
	 * runs again, announced with `loading` (then `bound` or `failed`).
	 */
	wake(): void {
		const state = this.#state;
		if (state.kind === "unplaced") {
			this.#state = PENDING;
			this.start(state.request);
		} else if (state.kind === "refused") {
			this.#restart(state.request);
		}
	}

	/**
	 * The object's state changed, or the hold took it: a pending hold binds once it is live (when a slot is free),
	 * sends each failure, and announces the attempt after a failure with `loading`. A live object stays live until it
	 * ends, so a hold waiting for its slot or bound has nothing to do (slice 7's reload changes that).
	 */
	moved(): void {
		const current = this.#state;
		if (current.kind !== "pending") return;
		const state = this.#object!.state;
		if (state.kind === "live") {
			this.#state = BINDING;
			this.#provider.bind(this, this.#provider.link.context);
		} else if (state.kind === "failed") {
			// Each failure and each new cause (a parked object's blocker changed) is a message of its own.
			const { cause, retryAt } = state;
			const retryIn = retryAt === undefined ? {} : { retryIn: Math.max(0, retryAt - Date.now()) };
			const failed = { kind: cause.kind, error: wireError(cause.error) };
			this.#provider.send({ kind: "failed", hold: this.id, cause: failed, ...retryIn });
			this.#state = { kind: "pending", toldFailed: true };
		} else if (state.kind === "loading" && current.toldFailed) {
			this.#provider.send({ kind: "loading", hold: this.id });
			this.#state = PENDING;
		}
	}

	/**
	 * A `retry` message, of its retry operation (a new one when it names none) through the objects it names: the object is
	 * asked for an attempt now (it ignores this unless failed, or when the operation reached it before; parked, it
	 * passes it on); a refused hold is
	 * started again (a route's `authorize` may admit it now).
	 */
	retry({ operation, through = [] }: Extract<Message, { readonly kind: "retry" }>): void {
		const state = this.#state;
		if (state.kind !== "refused") {
			this.#object?.retry(operation === undefined ? retryOperation() : { id: operation, through });
			return;
		}
		if (state.cause.kind === "waiting") this.#provider.link.host.unindex(state.request.type, this);
		this.#restart(state.request);
	}

	/** Starts a refused hold again, announced with `loading`. */
	#restart(request: HoldRequest): void {
		this.#state = PENDING;
		this.#provider.send({ kind: "loading", hold: this.id });
		this.start(request);
	}

	/** Calls a method of the held object as the hold's caller. */
	call(method: string, args: unknown, context: Context): Promise<unknown> {
		return this.#object!.call(method, args, context, this.caller);
	}

	/**
	 * The method at `index` of the bound variant and whether its result carries byte segments (its schema has a
	 * `bytes()` leaf). Throws on an index outside the variant (a protocol error); a hold that is not bound has none.
	 */
	method(index: number): { readonly name: string; readonly resultBytes: boolean } {
		const state = this.#state;
		const name = state.kind === "bound" ? state.names.methods[index] : undefined;
		if (name === undefined) throw new Error(`hold ${this.id}: no method ${index}`);
		// The bound state holds the variant whose names these are.
		const { variant } = state as Bound;
		return { name, resultBytes: variant.methods.get(name)!.result.bytes };
	}

	/**
	 * The hold's binding, sent when a slot is free. The snapshot of every member, as a value or failed, and the
	 * subscription are taken in this synchronous step (race 2), so each member's next ops continue exactly from it.
	 * Names travel as indexes into the bound version (2b). Counts one encode (`chord.link.encodes`).
	 */
	boundEntry(context: Context): BoundEntry {
		const object = this.#object!;
		const { contract } = object.served;
		// A live remote object has its variant.
		const variant = object.variant!;
		const state = this.#bindTo(object);
		const members: BoundEntry["members"][number][] = [];
		const failed: FailedMember[] = [];
		for (const [member, source] of object.stateMembers) {
			const index = state.names.state.indexOf(member);
			let value: JsonValue;
			try {
				value = source.value;
			} catch (error) {
				// A failed member (a derive whose compute throws) is followed: it recovers with a root replacement.
				failed.push({ member: index, error: wireError(error) });
				if (source instanceof Source) this.#follow(state, index, source);
				continue;
			}
			try {
				members.push({ member: index, value: this.#provider.link.part(jsonPart(value), context) });
			} catch (error) {
				// A value past the link's limits: failed for this hold, which takes no more of it.
				failed.push({ member: index, error: wireError(error) });
				continue;
			}
			// A constant never changes: nothing to follow.
			if (source instanceof Source) this.#follow(state, index, source);
		}
		this.#changes = [];
		this.#failed = [];
		this.#retired = NO_RETIRED;
		context.telemetry.metrics?.counter("chord.link.encodes").add(1);
		return { hold: this.id, variant: variantOrder(contract).indexOf(variant), members, failed };
	}

	/**
	 * This batch's entry of the `state` message: the members it changed with their ops, each encoded once with its
	 * member's encoder, and the members that failed; resets both. Counts one encode per hold (`chord.link.encodes`).
	 */
	entry(context: Context): StateEntry {
		const { link } = this.#provider;
		const members = this.#take().map(([{ index, encoder }, ops]) => ({
			member: index,
			ops: link.part(jsonPart(encoder.encode(ops)), context),
		}));
		return this.#entry(members, context);
	}

	/** The window is full: this batch's ops join the members' pending queues (raw, never mutated). */
	queue(): void {
		for (const [{ pending }, ops] of this.#take()) pending.push(ops);
	}

	/**
	 * The entry of a freed slot's `state` message: each member's pending ops encoded once, or `[["r", value]]` after an
	 * overflow, all reflecting the latest commit; and the members that failed meanwhile. Counts one encode per hold.
	 */
	pendingEntry(context: Context): StateEntry {
		const { link } = this.#provider;
		const members: StateEntry["members"][number][] = [];
		// Only a bound hold has pending ops.
		for (const { index, source, encoder, pending } of (this.#state as Bound).followed) {
			if (pending.size === 0) continue;
			const taken = pending.take();
			const ops = taken.kind === "replace" ? [["r", source.value] as const] : taken.ops;
			if (ops.length > 0) members.push({ member: index, ops: link.part(jsonPart(encoder.encode(ops)), context) });
		}
		return this.#entry(members, context);
	}

	/** The consumer released the hold, or its link closed: its waits stop and its object loses this reference. */
	release(): void {
		this.drop();
		this.#object?.unhold(this);
		this.#object = undefined;
	}

	/** Ends the hold without releasing its object (the host closes and ends its objects itself). */
	drop(): void {
		const state = this.#state;
		const { host } = this.#provider.link;
		if (state.kind === "bound") {
			for (const { source, subscriber } of state.followed) source.unsubscribe(subscriber);
		} else if (state.kind === "unplaced" || (state.kind === "refused" && state.cause.kind === "waiting")) {
			host.unindex(state.request.type, this);
		}
		this.#state = { kind: "released" };
		if (this.#counted) host.count("references", -1);
		this.#counted = false;
	}

	/**
	 * The object ended while held (revocation; a reload, slice 7b), or the hold was revoked (or its host closed) while it
	 * held no object: the hold sends `gone` with `error`.
	 */
	end(error: ChordError): void {
		if (this.#state.kind === "released") return;
		this.#provider.forget(this, error);
		this.drop();
		this.#object = undefined;
		this.#provider.send({ kind: "gone", hold: this.id, error: wireError(error) });
	}

	/** The binding: its variant and names, with no member followed yet. */
	#bindTo(object: ChordObject): Bound {
		const data = currentVariants(object.served.contract).get(object.variant!)!;
		const state: Bound = { kind: "bound", variant: data, names: variantNames(data), followed: [] };
		this.#state = state;
		return state;
	}

	/**
	 * Follows member `index` from its snapshot on (a failed one too: it may recover in this hold): its own encoder and
	 * pending queue, and a subscription feeding its calls into this hold's batch. Failures fold per member: a failure
	 * drops what was pending for it and replaces a failure not sent yet (one at most per member, however long the
	 * consumer stalls); the value after it (a root replacement) replaces the failure. A retirement waits for a value.
	 */
	#follow(state: Bound, index: number, source: Source): void {
		const followed: Followed = {
			index,
			source,
			subscriber: {
				advance: (call) => {
					this.#touch();
					if (call.kind === "failed") {
						followed.pending.take();
						const failure = { member: index, error: wireError(call.error) };
						const at = this.#failed.findIndex(({ member }) => member === index);
						// A new list when one is replaced (rare): a list handed to an entry is never written to.
						if (at === -1) this.#failed.push(failure);
						else this.#failed = this.#failed.map((pending, i) => (i === at ? failure : pending));
						return;
					}
					// Rare: a failure of this member still waits to be sent.
					if (this.#failed.length > 0) this.#failed = this.#failed.filter(({ member }) => member !== index);
					const { ops, retired } = call;
					// A retired derive's frame may carry no ops (rule 21): only the flag travels.
					if (ops.length > 0) this.#changes.push([followed, ops]);
					// A new list per retirement (rare): the shared empty one is never written to.
					if (retired && !this.#retired.includes(index)) this.#retired = [...this.#retired, index];
				},
				// The member's source ended with its object, which ends this hold.
				end: () => {},
				endAfterDelivery: () => {},
			},
			encoder: encoder(),
			pending: new PendingOps(),
		};
		source.subscribe(followed.subscriber);
		state.followed.push(followed);
	}

	/** Takes the current batch's changes; the hold is untouched again. */
	#take(): (readonly [Followed, readonly Op[]])[] {
		const changes = this.#changes;
		this.#changes = [];
		this.#touched = false;
		return changes;
	}

	/** A state entry with `members` and the failures and retirements since the last one; counts one encode. */
	#entry(members: StateEntry["members"], context: Context): StateEntry {
		const failed = this.#failed;
		let retired = this.#retired;
		this.#failed = [];
		this.#retired = NO_RETIRED;
		if (retired.length > 0 && failed.length > 0) {
			// A failed member's retirement travels with its next value, never with its failure.
			const kept = retired.filter((index) => failed.some(({ member }) => member === index));
			if (kept.length > 0) {
				this.#retired = kept;
				retired = retired.filter((index) => !kept.includes(index));
			}
		}
		context.telemetry.metrics?.counter("chord.link.encodes").add(1);
		return { hold: this.id, members, failed, retired };
	}

	#touch(): void {
		if (this.#touched) return;
		this.#touched = true;
		this.#provider.touched(this);
	}

	/**
	 * Refuses the hold with `cause`, holding nothing: it keeps `request`, indexed under its type while `waiting` (a
	 * publication starts it again), for a `retry` otherwise.
	 */
	#refuse(request: HoldRequest, cause: FailureCause): void {
		this.#state = { kind: "refused", request: owned(request), cause };
		if (cause.kind === "waiting") this.#provider.link.host.index(request.type, this);
		this.#provider.send({
			kind: "failed",
			hold: this.id,
			cause: { kind: cause.kind, error: wireError(cause.error) },
		});
	}
}

/** `request` with its params owned, not a view of the message they came in (which the link's buffers may hold). */
function owned(request: HoldRequest): HoldRequest {
	const { params } = request;
	return typeof params === "string" ? request : { ...request, params: (params as Uint8Array).slice() };
}

/** A `hold` message's fields naming whom it acts for. */
type ActingFor = Pick<HoldMessage, "principal" | "incarnation">;

const NOBODY: ActingFor = {};

/**
 * The fields of a `hold` message naming whom it acts for (`caller`): sent only on a route link, whose child honours
 * them (§4); none elsewhere.
 */
export function actingFor(link: HostLink, { principal, incarnation }: Caller): ActingFor {
	return link.role === "route" && principal !== undefined ? { principal, incarnation } : NOBODY;
}
