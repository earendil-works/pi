// An object held over a link (§7): what one remote reference is bound to on the consumer, across the links of its path
// (the parent, or a route address). Its state, the replicas of its last bound variant (kept while its link is down),
// its hold on the path's current link and calls through it.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import {
	currentVariants,
	type MethodData,
	type VariantNames,
	variantNames,
	variantOrder,
} from "../contracts/internal.ts";
import { ChordError } from "../data/index.ts";
import { asChordError, invalid } from "../data/internal.ts";
import {
	type AnyHost,
	type Binding,
	type Caller,
	type CheckedParams,
	type ChordObject,
	LIVE,
	LOADING,
	type PinnedKey,
	type RefState,
	settlement,
	type Target,
} from "../host/internal.ts";
import {
	type BoundEntry,
	errorFromWire,
	jsonPart,
	type Message,
	parsePart,
	type StateEntry,
	type WireAddress,
} from "../link/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import type { ConsumerSide } from "./consumer.ts";
import type { HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import { type MemberSnapshot, Replica } from "./replica.ts";

/** The last binding: its variant, methods, the bound version's names (the wire's indexes) and a replica per member. */
type Bound = {
	readonly variant: string;
	readonly methods: ReadonlyMap<string, MethodData>;
	readonly names: VariantNames;
	readonly replicas: ReadonlyMap<string, Replica>;
};

/**
 * One remote reference's object, owned by its host across the links of its path. It is `loading` until a link's hold
 * of it is bound, and again whenever that link drops or its relay's upstream starts over; each link holds it with its
 * own id. Two references are two holds, each member of each with its own Delta decoder.
 */
export class RemoteObject implements Target {
	readonly kind = "remote";
	/** The object in errors: its type, and its params key when it has params. */
	readonly label: string;
	readonly contract: Contract;
	readonly #host: AnyHost;
	/** What its holds ask for: the params as a part (checked by L1 when the reference was made), the address. */
	readonly request: HoldRequest;
	/** Whom its reference acts for: named on route links (`actingFor`). */
	readonly caller: Caller;
	/** Its params, for placing it anew (`retry` after a part past the limits). */
	readonly #params: ParamsOf<Contract>;
	/** Its path: the parent's or a route address's; the host's `unplaced` one after a part past the limits. */
	#path: Path;
	/** The object whose activation declared the reference (`self.get`): its holds carry its chain while it activates. */
	#dependent: ChordObject | undefined;
	#state: RefState = LOADING;
	/** The last binding, kept while loading or failed: members keep their last values and watches. */
	#bound: Bound | undefined;
	/** The hold on the path's link while one is open: that link's consumer side and this hold's id on it. */
	#hold: { readonly side: ConsumerSide; readonly id: number } | undefined;
	#binding: Binding | undefined;
	/** Pending while loading, resolved while live, rejected while failed: a dependent's activation waits for it (R18). */
	#settled = settlement();
	#lastFailure: ChordError | undefined;

	constructor(
		host: AnyHost,
		contract: Contract,
		{ params, key }: CheckedParams,
		address: WireAddress | undefined,
		caller: Caller,
		path: Path,
		dependent: ChordObject | undefined,
	) {
		this.#host = host;
		this.contract = contract;
		this.label = key === "" ? contract.name : `${contract.name}(${key})`;
		const { name: type, version, fingerprint } = contract;
		this.request = {
			type,
			version,
			fingerprint,
			params: jsonPart(params),
			...(address === undefined ? {} : { address }),
		};
		this.caller = caller;
		this.#params = params;
		this.#path = path;
		this.#dependent = dependent;
	}

	get state(): RefState {
		return this.#state;
	}

	/** Pending while loading; resolves when bound, rejects with a failure or the reference's end. */
	get settled(): Promise<void> {
		return this.#settled.promise;
	}

	/** The error of the last `failed`, until `bound`. */
	get lastFailure(): ChordError | undefined {
		return this.#lastFailure;
	}

	/** The variant last bound; `undefined` before the first binding. */
	get variant(): string | undefined {
		return this.#bound?.variant;
	}

	/** Whether its state members have values: bound once. */
	get hydrated(): boolean {
		return this.#bound !== undefined;
	}

	/** Its one reference bound to it. */
	hold(binding: Binding): void {
		this.#binding = binding;
	}

	/** The reference was released: the current link's provider is told and the reference's sent calls rejected. */
	unhold(_binding: Binding): void {
		const error = new ChordError({ code: "released", message: `${this.label}: released` });
		this.#hold?.side.release(this.#hold.id, error);
		this.#end(error);
	}

	/**
	 * Holds on `link`, the path's link now (a first hold, or a re-hold on a new link), with the activation chain of its
	 * dependent while that activates (Q5).
	 */
	attach(link: HostLink): void {
		const chain = this.#dependent?.activationChain();
		this.#hold = { side: link.consumer, id: link.consumer.attach(this, chain) };
	}

	/** The link dropped with `error`: loading until a new link's hold is bound (`#startOver`). */
	dropped(error: ChordError): void {
		this.#hold = undefined;
		this.#startOver(error);
	}

	/**
	 * Calls a method of the bound variant over the link; one outside it fails `invalid/member`. Only a live object is
	 * called: bound on an open link.
	 */
	async call(method: string, args: unknown, context: Context): Promise<unknown> {
		const bound = this.#bound!;
		const hold = this.#hold!;
		const data = bound.methods.get(method);
		if (data === undefined) {
			throw invalid("member", `${this.label} (variant ${bound.variant}) has no method "${method}"`);
		}
		// Arguments are checked by the provider.
		return hold.side.call(hold.id, bound.names.methods.indexOf(method), data, args, context);
	}

	/**
	 * The replica of `member`; `not_ready` before the first binding, `invalid/member` for a member no binding had (one
	 * a later variant lacks reads its `invalid/member` failure).
	 */
	member(member: string): DeriveSource {
		const bound = this.#bound;
		if (bound === undefined) throw new ChordError({ code: "not_ready", message: `${this.label}: not bound yet` });
		const replica = bound.replicas.get(member);
		if (replica === undefined) {
			throw invalid("member", `${this.label} (variant ${bound.variant}) has no state member "${member}"`);
		}
		return replica;
	}

	/** A failed remote object's members are not read: its failure is the reads' error (see `Target.lastValues`). */
	get lastValues(): false {
		return false;
	}

	/** Keyed members are only in local contracts (`keyedMember`). */
	async pinKey(member: string): Promise<PinnedKey> {
		return this.keyedMember(member);
	}

	/** Keyed members are only in local contracts, whose objects are never held over a link (slice 6a §12). */
	keyedMember(member: string): never {
		throw invalid("member", `${this.label} has no keyed member "${member}": keyed members are local`);
	}

	/** An object over a link activates on another host: it is in no chain here (Q5). */
	get activationId(): undefined {
		return undefined;
	}

	/** An object over a link waits for nothing on this host: no chain of waits (its holds carry the chain, Q5). */
	pathTo(): undefined {
		return undefined;
	}

	/**
	 * `ref.retry()`: a failed object's provider is asked for an attempt; one that failed for a part past the link's
	 * limits is placed anew and held with a new id, now or on its path's next link (a placement that throws fails it
	 * broken again); ignored otherwise and without a link.
	 */
	retry(): void {
		if (this.#state.kind !== "failed") return;
		if (this.#path !== this.#host.unplaced) {
			this.#hold?.side.retry(this.#hold.id);
			return;
		}
		let path: Path;
		try {
			path = this.#host.pathOf(this.contract, this.#params, this.caller.principal);
		} catch (error) {
			this.#fail(asChordError(error, this.contract.name));
			return;
		}
		this.#path.detach(this);
		this.#path = path;
		this.#move(LOADING);
		path.attach(this);
	}

	/**
	 * A part of its snapshot or of a state change was past the link's limits (`too_large/part`): the hold is released
	 * at the provider, and the reference fails broken with `error`, final: no link holds it again (a reconnect
	 * included) until `retry`.
	 */
	tooLarge(error: ChordError): void {
		const hold = this.#hold;
		if (hold === undefined) return;
		this.#hold = undefined;
		hold.side.release(hold.id, error);
		this.#path.detach(this);
		this.#path = this.#host.unplaced;
		this.#path.attach(this);
		this.#fail(error);
	}

	/** Fails broken with `error`: no automatic retry. */
	#fail(error: ChordError): void {
		this.#lastFailure = error;
		this.#move({ kind: "failed", cause: { kind: "broken", error }, retryAt: undefined });
	}

	/**
	 * Prepares one entry of a `bound` message (a first binding, a re-hold; a live hold is bound again): the
	 * variant and every state member once, as a value or as failed. Returns what applies it inside the batch of the
	 * whole message: a member it had gets the snapshot as one frame `[["r", value]]` and a fresh decoder, a member
	 * outside the new variant fails (its replica stays, for a later binding that has it again), a new one gets its first
	 * value. Throws on a snapshot that
	 * does not fit (a protocol error), and `too_large/part` for a value past the link's limits, before anything changed.
	 * `wentLive` follows the batch.
	 */
	prepareBound(entry: BoundEntry, link: HostLink): () => void {
		const variant = variantOrder(this.contract)[entry.variant];
		if (variant === undefined) throw new Error(`hold ${entry.hold}: no variant ${entry.variant}`);
		const data = currentVariants(this.contract).get(variant)!;
		const names = variantNames(data);
		const members = new Map<string, MemberSnapshot>();
		const add = (index: number, state: MemberSnapshot): void => {
			const member = names.state[index];
			if (member === undefined || members.has(member))
				throw new Error(`hold ${entry.hold}: member ${index} in bound`);
			members.set(member, state);
		};
		// Fresh JSON from the link: state is JSON and never validated (§30).
		for (const { member, value } of entry.members) {
			add(member, { kind: "value", value: parsePart(link.openPart(value, link.limits, link.context)) as JsonValue });
		}
		for (const { member, error } of entry.failed) add(member, { kind: "failed", error: errorFromWire(error) });
		if (members.size !== names.state.length) throw new Error(`hold ${entry.hold}: the snapshot misses a member`);
		return () => {
			const previous = this.#bound?.replicas;
			const replicas = new Map<string, Replica>();
			// First: a derive recomputing in this batch reads the new variant through its reference.
			this.#bound = { variant, methods: data.methods, names, replicas };
			for (const [member, state] of members) {
				const replica = previous?.get(member);
				if (replica === undefined) {
					replicas.set(member, new Replica(this.#host.batch, state));
				} else {
					replica.reset(state);
					replicas.set(member, replica);
				}
			}
			for (const [member, replica] of previous ?? []) {
				if (members.has(member)) continue;
				replica.vanish(invalid("member", `${this.label} (variant ${variant}) has no state member "${member}"`));
				replicas.set(member, replica);
			}
		};
	}

	/** After a `bound` message's batch: the reference goes live (its parked calls are sent) and R18 retries follow. */
	wentLive(): void {
		this.#lastFailure = undefined;
		this.#move(LIVE);
		// R18: a dependent that failed while waiting for this object is retried now.
		this.#binding?.dependent?.dependencyLive();
	}

	/**
	 * `failed`: the provider's object failed and no attempt runs; `retryIn` is the rest of its backoff window. Ignored
	 * once live (only a pending hold is told).
	 */
	failed(message: Extract<Message, { readonly kind: "failed" }>): void {
		if (this.#state.kind === "live") return;
		// A plugin's error a provider failed with is this object's failure, as a ChordError.
		const error = asChordError(errorFromWire(message.cause.error), this.label);
		this.#lastFailure = error;
		const retryAt = message.retryIn === undefined ? undefined : Date.now() + message.retryIn;
		this.#move({ kind: "failed", cause: { kind: message.cause.kind, error }, retryAt });
	}

	/**
	 * `loading`: the provider's object started a new attempt after a failure, or its relay's upstream link dropped
	 * (`#startOver`).
	 */
	loading(): void {
		this.#startOver(
			new ChordError({ code: "unavailable", message: `${this.label}: its relay's upstream link dropped` }),
		);
	}

	/**
	 * Decodes and applies one entry of a state message (its members by index, each with its ops), without changing
	 * anything yet: returns what adopts it into the replicas, run inside the batch that applies the whole message.
	 * Throws on an entry that does not fit (a protocol error), and `too_large/part` for ops past the link's limits.
	 */
	prepare({ hold: id, members, failed, retired }: StateEntry, link: HostLink): () => void {
		const bound = this.#bound;
		if (this.#state.kind !== "live" || bound === undefined) throw new Error(`hold ${id}: state before bound`);
		const replica = (index: number): Replica => {
			const name = bound.names.state[index];
			const found = name === undefined ? undefined : bound.replicas.get(name);
			if (found === undefined) throw new Error(`hold ${id}: no state member ${index}`);
			return found;
		};
		// Made by the first retirement (rare): no allocation per message otherwise.
		let retirements: Set<Replica> | undefined;
		for (const member of retired) {
			const target = replica(member);
			retirements ??= new Set();
			if (retirements.has(target)) throw new Error(`hold ${id}: member ${member} retired twice in one state`);
			retirements.add(target);
		}
		const changed = new Set<Replica>();
		const updates = members.map(({ member, ops }) => {
			const target = replica(member);
			if (changed.has(target)) throw new Error(`hold ${id}: member ${member} twice in one state`);
			changed.add(target);
			return { target, ...target.decode(parsePart(link.openPart(ops, link.limits, link.context))) };
		});
		const failures = failed.map(({ member, error }) => ({ target: replica(member), error: errorFromWire(error) }));
		return () => {
			for (const { target, value, ops } of updates) target.adopt(value, ops, retirements?.has(target) === true);
			for (const { target, error } of failures) target.fail(error);
			// A retirement without ops (a derive whose value stayed, rule 21): the flag alone, after the failures (a
			// failed member keeps it for its next value).
			if (retirements !== undefined) {
				for (const target of retirements) if (!changed.has(target)) target.retireAlone();
			}
		};
	}

	/** `gone`, or the host closes: the reference ends, its calls reject with `error`. */
	lost(error: ChordError): void {
		const binding = this.#binding;
		this.#hold?.side.forget(this.#hold.id, error);
		this.#end(error);
		binding?.end(error);
	}

	/** Ends the object: detached from its path, waits rejected, replicas ended; keeps nothing of its reference. */
	#end(error: ChordError): void {
		const bound = this.#bound;
		this.#state = { kind: "ended", error };
		this.#binding = undefined;
		this.#dependent = undefined;
		this.#hold = undefined;
		this.#bound = undefined;
		this.#settled.reject(error);
		this.#path.detach(this);
		for (const replica of bound?.replicas.values() ?? []) replica.end(error);
	}

	/**
	 * Loading again until the next binding; the members keep their last values. A dependent's activation waiting for
	 * this hold while it was loading already fails at once with `error` (transient) and is retried when a new hold is
	 * bound (R18).
	 */
	#startOver(error: ChordError): void {
		if (this.#state.kind === "ended") return;
		if (this.#state === LOADING) {
			this.#settled.reject(error);
			this.#settled = settlement();
		} else {
			this.#move(LOADING);
		}
	}

	/** Moves to `state` and tells the reference; `settled` follows (a new wait each time it is loading again). */
	#move(state: RefState): void {
		const previous = this.#state;
		this.#state = state;
		if (state.kind === "loading" && previous.kind !== "loading") this.#settled = settlement();
		if (state.kind === "live") this.#settled.resolve();
		if (state.kind === "failed") this.#settled.reject(state.cause.error);
		this.#binding?.moved();
	}
}
