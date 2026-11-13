// An object held over a link (§7): what the remote references of this host with one sharing key are bound to, across
// the links of its path (the parent, or a route address); one hold for all of them (decision "References share one
// wire hold"). Its state, the replicas of its last bound variant (kept while its link is down), the nodes its events
// arrive at (decision "Events: fire-and-forget members"), its bindings (each reference's own release, calls and seen
// members), its hold on the path's current link and calls through it: its hold in a `chord.hold` span until bound
// (shared work: a root on the host's adapter), each call in a `chord.call` span, their carriers on the wire (slice 9).

import type { TelemetryCarrier, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../context/index.ts";
import type { Contract } from "../contracts/index.ts";
import {
	currentVariants,
	type MethodData,
	type VariantNames,
	variantNames,
	variantOrder,
} from "../contracts/internal.ts";
import { ChordError, isChordError } from "../data/index.ts";
import { asChordError, invalid } from "../data/internal.ts";
import {
	type AnyHost,
	type Attachable,
	type Binding,
	type Caller,
	type CheckedParams,
	type ChordObject,
	EventNode,
	type Followed,
	LIVE,
	LOADING,
	type PinnedKey,
	type RefState,
	type RetryWalk,
	type Target,
} from "../host/internal.ts";
import type { JsonValue } from "../json.ts";
import {
	type BoundEntry,
	errorFromWire,
	jsonPart,
	type Message,
	type Part,
	parsePart,
	type StateEntry,
	type WireAddress,
} from "../link/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import { capped, carrierOf, chordSpans, ended, OpenSpan, parentOf, spanFailed, untraced } from "../telemetry.ts";
import type { ConsumerSide } from "./consumer.ts";
import type { HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import { type MemberSnapshot, Replica } from "./replica.ts";

/**
 * The last binding: its variant, methods, the bound version's names (the wire's indexes), a replica per member, and a
 * node per event member, at which the events arriving for this binding go out (a new binding has new nodes, so its
 * reference's subscriptions move there from its counter value: nothing of an earlier binding reaches them).
 */
type Bound = {
	readonly variant: string;
	readonly methods: ReadonlyMap<string, MethodData>;
	readonly names: VariantNames;
	readonly replicas: ReadonlyMap<string, Replica>;
	/** Event member `member`'s node (its reference binds at its own version: the provider mapped what arrives). */
	eventNode(member: string): EventNode | undefined;
};

/**
 * The event nodes of a new binding with event members `members` (new nodes: nothing of an earlier binding reaches its
 * reference's subscriptions); one shared lookup without nodes for a variant without event members.
 */
function eventNodes(members: readonly string[]): (member: string) => EventNode | undefined {
	if (members.length === 0) return NO_EVENT_NODES;
	const nodes = new Map(members.map((member) => [member, new EventNode()]));
	return (member) => nodes.get(member);
}

const NO_EVENT_NODES = (): undefined => undefined;

/**
 * The object of the remote references with one sharing key, owned by its host across the links of its path (one held
 * by a `self.get` reference or a private retry is its reference's alone). It is `loading` until a link's hold of it is
 * bound, and again whenever that link drops or its relay's upstream starts over; each link holds it once, with its own
 * id, each member with its own Delta decoder. It tells every binding of each change; the hold ends with the last.
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
	/** Its params as L1 checked them, for placing it anew (a private retry after a part past the limits). */
	readonly #params: CheckedParams;
	/** Its path: the parent's or a route address's; the host's `unplaced` one after a part past the limits. */
	#path: Path;
	/** The object whose activation declared the reference (`self.get`): its holds carry its chain while it activates. */
	#dependent: ChordObject | undefined;
	#state: RefState = LOADING;
	/** The last binding, kept while loading or failed: members keep their last values and watches. */
	#bound: Bound | undefined;
	/** The hold on the path's link while one is open: that link's consumer side and this hold's id on it. */
	#hold: { readonly side: ConsumerSide; readonly id: number } | undefined;
	/** Its references' bindings, in the order they joined; the hold ends with the last. */
	readonly #bindings = new Set<Binding>();
	/** Takes its entry out of its path's sharing table, once; none for a private object or once taken out. */
	#unindex: (() => void) | undefined;
	#lastFailure: ChordError | undefined;
	/** Its current `chord.hold` span until its hold's `bound` or failure; none when nothing records. */
	#holding: OpenSpan<"chord.hold"> | undefined;
	/** The carrier of its first hold's span: a re-hold's span links to it. */
	#firstHold: TelemetryCarrier | undefined;
	/** How many times it was held (on the links of its path). */
	#holds = 0;

	/**
	 * Made for its first reference (its getter's `trigger`), on `path`; `unindex` takes it out of its path's sharing
	 * table (none: a private object, never shared).
	 */
	constructor(
		host: AnyHost,
		contract: Contract,
		params: CheckedParams,
		address: WireAddress,
		caller: Caller,
		path: Path,
		dependent: ChordObject | undefined,
		trigger: TelemetryContext,
		unindex?: () => void,
	) {
		this.#host = host;
		this.contract = contract;
		this.label = params.key === "" ? contract.name : `${contract.name}(${params.key})`;
		const { name: type, version, fingerprint } = contract;
		// Its hold is shared work (decision "Shared work"): a root on the host's adapter whatever its first getter's
		// context, linked to that getter's span when traced; its first hold carries the span's carrier (`#holdTrace`).
		if (!untraced(host.telemetry)) {
			this.#holding = new OpenSpan(host.telemetry, "chord.hold", {
				"chord.host": host.spanHost,
				type,
				object: capped(this.label),
				"address.kind": address.kind,
			});
			if (!untraced(trigger)) this.#holding.span.addLink({ context: trigger });
			this.#firstHold = carrierOf(this.#holding.span);
		}
		this.request = { type, version, fingerprint, params: jsonPart(params.params), address };
		this.caller = caller;
		this.#params = params;
		this.#path = path;
		this.#dependent = dependent;
		this.#unindex = unindex;
	}

	get state(): RefState {
		return this.#state;
	}

	/** Over a link the provider decides what each version sees: its state as it is. */
	stateFor(): RefState {
		return this.#state;
	}

	/** Its `chord.hold` span until its first `bound` or failure (a route's resolve links to it); none when not recorded. */
	get span(): TelemetrySpan | undefined {
		return this.#holding?.span;
	}

	/** An object over a link is no blocker of this host's first pass. */
	get blocksFirstPass(): false {
		return false;
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

	/** Whether its path is the host's unplaced one: a part past the limits failed it, so it holds nothing anywhere. */
	get unplaced(): boolean {
		return this.#path === this.#host.unplaced;
	}

	/**
	 * Counts `binding` as one of its references. One joining it after it was bound (decision "References share one wire
	 * hold") has not seen what it finds: every member when it is not live, else the members failed or missing from the
	 * bound variant; each counts as seen once its replica takes a value after the join. `Binding.bind` retargets and
	 * tells it.
	 */
	hold(binding: Binding): void {
		const bound = this.#bound;
		if (bound !== undefined && this.#bindings.size > 0) binding.joined(this.#unseen(bound));
		this.#bindings.add(binding);
	}

	/**
	 * The members a binding joining now has not seen, each with its replica's count of values now (0 without one): its
	 * own history starts there.
	 */
	#unseen(bound: Bound): ReadonlyMap<string, number> {
		const live = this.#state.kind === "live";
		const unseen = new Map<string, number>();
		for (const variant of currentVariants(this.contract).values()) {
			for (const member of variant.state.keys()) {
				const replica = bound.replicas.get(member);
				const good = live && bound.names.state.includes(member) && replica?.start().kind === "value";
				if (!good) unseen.set(member, replica?.generation ?? 0);
			}
		}
		return unseen;
	}

	/** How many values the replica of `member` took; `undefined` without one. */
	generationOf(member: string): number | undefined {
		return this.#bound?.replicas.get(member)?.generation;
	}

	/**
	 * `binding` was released. While others remain nothing is sent but the cancellation of its own calls (queued ones
	 * leave unsent, sent ones are aborted); with the last the hold is released and the object ends (no linger, D8).
	 */
	unhold(binding: Binding): void {
		if (!this.#bindings.delete(binding)) return;
		if (this.#bindings.size > 0) {
			this.#hold?.side.cancelCalls(this.#hold.id, binding, this.label);
			return;
		}
		const error = new ChordError({ code: "released", message: `${this.label}: released` });
		// Out of the table before anything else runs: a reference made from here on holds anew.
		this.#unpublish();
		this.#hold?.side.release(this.#hold.id, error);
		this.#end(error);
	}

	/** Leaves its path's sharing table (once): it is never put back. */
	#unpublish(): void {
		const unindex = this.#unindex;
		this.#unindex = undefined;
		unindex?.();
	}

	/**
	 * Holds on `link`, the path's link now (a first hold, or a re-hold on a new link), with the activation chain of its
	 * dependent while that activates (Q5).
	 */
	attach(link: HostLink): void {
		const chain = this.#dependent?.activationChain();
		this.#hold = { side: link.consumer, id: link.consumer.attach(this, chain, this.#holdTrace()) };
	}

	/**
	 * The carrier of this hold: the first one's span's (a root of this host's adapter); a re-hold on a later link (a
	 * reconnect, days later for a page kept open) is a fresh `chord.hold` root linked to the first, so nothing keeps
	 * adding children under a span long ended (review L1). None when the host's adapter records nothing (then the first
	 * hold had no span either, whatever its getter's context).
	 */
	#holdTrace(): TelemetryCarrier | undefined {
		if (this.#holds++ === 0) return this.#firstHold;
		if (this.#firstHold === undefined) return undefined;
		const adapter = this.#host.telemetry;
		// A hold that dropped before it was bound ends here.
		this.#held("ended");
		const attributes = {
			"chord.host": this.#host.spanHost,
			type: this.contract.name,
			object: capped(this.label),
			"address.kind": this.request.address.kind,
		};
		this.#holding = new OpenSpan(adapter, "chord.hold", attributes);
		this.#holding.span.addLink({ context: parentOf(this.#firstHold, adapter) });
		return carrierOf(this.#holding.span);
	}

	/**
	 * Its path's address cannot be reached for now (a route's `resolve` failed, a suspension): `failed { waiting }` with
	 * `error`, still on the path, bound by its next link.
	 */
	unreachable(error: ChordError): void {
		this.#lastFailure = error;
		this.#held("failed", error);
		if (this.#state.kind !== "ended")
			this.#move({ kind: "failed", cause: { kind: "waiting", error }, retryAt: undefined });
	}

	/** The link dropped: loading until a new link's hold is bound (`#startOver`). */
	dropped(_error: ChordError): void {
		this.#hold = undefined;
		this.#startOver();
	}

	/**
	 * Calls a method of the bound variant over the link; one outside it fails `invalid/member`. Only a live object is
	 * called: bound on an open link.
	 */
	async call(method: string, args: unknown, binding: Binding, context: Context): Promise<unknown> {
		const bound = this.#bound!;
		const hold = this.#hold!;
		const data = bound.methods.get(method);
		if (data === undefined) {
			throw invalid("member", `${this.label} (variant ${bound.variant}) has no method "${method}"`);
		}
		const index = bound.names.methods.indexOf(method);
		// Arguments are checked by the provider.
		const parent = context.telemetry;
		if (untraced(parent)) return hold.side.call(hold.id, index, data, args, binding, context);
		const attributes = {
			"chord.host": this.#host.spanHost,
			type: this.contract.name,
			member: method,
			object: capped(this.label),
			"address.kind": this.request.address.kind,
			...this.#host.principalAttributes(this.caller.principal, context),
		};
		return chordSpans(parent)("chord.call", attributes, async (span) => {
			try {
				const result = await hold.side.call(hold.id, index, data, args, binding, withTelemetry(span, context));
				span.setAttributes({ outcome: "ok" });
				return result;
			} catch (error) {
				span.setAttributes({ outcome: ended(span, "call_failed", error, context.abortSignal) });
				throw error;
			}
		});
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

	/**
	 * What its reference follows of `member` (a consumer over a link binds at its own version, mapped at the provider):
	 * the replica while live, a member the bound variant lacks (`invalid/member`); while loading or failed nothing, the
	 * replica (kept until the next binding) giving its last value (rule 5).
	 */
	followed(member: string, _version: number): Followed {
		const bound = this.#bound;
		const replica = bound?.replicas.get(member);
		const state = this.#state;
		if (state.kind === "live") {
			if (replica !== undefined) return { kind: "live", source: replica, instance: bound };
			const message = `${this.label} (variant ${bound?.variant}) has no state member "${member}"`;
			return { kind: "lacking", error: invalid("member", message) };
		}
		if (state.kind === "failed") return { kind: "failed", error: state.cause.error, last: replica, instance: bound };
		return { kind: "loading", last: replica, instance: bound };
	}

	/** Its binding while live (its replicas change); `undefined` while loading or failed. */
	get attachable(): Attachable | undefined {
		return this.#state.kind === "live" ? this.#bound : undefined;
	}

	/** Keyed members are only in local contracts: no instance to pin a key on. */
	get instance(): undefined {
		return undefined;
	}

	/** Keyed members are only in local contracts (`keyedMember`). */
	keyedMapping(member: string): never {
		return this.keyedMember(member);
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
	 * `ref.retry()` from `binding`, as a step of `walk`: a failed object's provider is asked for an attempt with the
	 * walk's hop budget, none left: nothing is sent (a hold it refused is started there again, for every reference
	 * sharing it; a parked object there passes it on with one hop less). After a part past the link's limits `binding`
	 * alone moves to a private object of its own, placed anew and held with a new id (`#retryAlone`).
	 */
	retry(walk: RetryWalk, binding: Binding): void {
		if (this.#state.kind !== "failed") return;
		if (this.unplaced) {
			this.#retryAlone(binding);
			return;
		}
		if (walk.hops > 0) this.#hold?.side.retry(this.#hold.id, walk.hops);
	}

	/**
	 * Moves `binding` to a private object (never shared) that keeps what this one had for it (its variant, copies of its
	 * replicas with their counts: its last values and seen members stay its own) and places it anew; the others stay
	 * here, failed, until they retry. The binding leaves first, so this object ending with its last binding never ends
	 * it. A placement that throws fails only the private object broken (`hostAddress`, a route that refuses).
	 */
	#retryAlone(binding: Binding): void {
		const { batch, unplaced } = this.#host;
		const own = new RemoteObject(
			this.#host,
			this.contract,
			this.#params,
			this.request.address,
			this.caller,
			unplaced,
			this.#dependent,
			BACKGROUND_CONTEXT.telemetry,
		);
		const bound = this.#bound;
		if (bound !== undefined) {
			const replicas = new Map([...bound.replicas].map(([member, replica]) => [member, replica.fork(batch)]));
			own.#bound = { ...bound, replicas, eventNode: eventNodes(bound.names.events) };
		}
		unplaced.attach(own);
		this.#bindings.delete(binding);
		binding.transfer(own);
		if (this.#bindings.size === 0)
			this.#end(new ChordError({ code: "released", message: `${this.label}: released` }));
		own.#place();
	}

	/** Places a private object anew, on its path now (a throwing `hostAddress` or route fails it broken). */
	#place(): void {
		let path: Path;
		try {
			path = this.#host.pathOf(this.contract, this.#params.params, this.caller.principal);
		} catch (error) {
			this.#fail(asChordError(error, this.contract.name));
			return;
		}
		this.#path.detach(this);
		this.#path = path;
		path.attach(this);
	}

	/**
	 * A part of its snapshot or of a state change was past the link's limits (`too_large/part`): the hold is released
	 * at the provider, it leaves the sharing table, and every binding fails broken with `error` (they share the part),
	 * final: no link holds it again (a reconnect included); each binding's `retry` moves it alone (`#retryAlone`).
	 */
	tooLarge(error: ChordError): void {
		const hold = this.#hold;
		if (hold === undefined) return;
		this.#hold = undefined;
		this.#unpublish();
		hold.side.release(hold.id, error);
		this.#path.detach(this);
		this.#path = this.#host.unplaced;
		this.#path.attach(this);
		this.#fail(error);
	}

	/** Fails broken with `error`: no automatic retry. */
	#fail(error: ChordError): void {
		this.#lastFailure = error;
		this.#held("failed", error);
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
			this.#bound = { variant, methods: data.methods, names, replicas, eventNode: eventNodes(names.events) };
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

	/** After a `bound` message's batch: the reference goes live (its parked calls are sent, a parked dependent goes on). */
	wentLive(): void {
		this.#lastFailure = undefined;
		this.#held("bound");
		this.#move(LIVE);
	}

	/**
	 * `failed`: the provider's object failed and no attempt runs (`retryIn`: the rest of its backoff window), or the hold
	 * is unbound there or its object parked on a failed dependency (`waiting`), each new cause a new message. On a bound
	 * hold it unbinds it (slice 7b, model §5): the members keep their last values until the next `bound`.
	 */
	failed(message: Extract<Message, { readonly kind: "failed" }>): void {
		// A plugin's error a provider failed with is this object's failure, as a ChordError.
		const error = asChordError(errorFromWire(message.cause.error), this.label);
		this.#lastFailure = error;
		this.#held("failed", error);
		const retryAt = message.retryIn === undefined ? undefined : Date.now() + message.retryIn;
		this.#move({ kind: "failed", cause: { kind: message.cause.kind, error }, retryAt });
	}

	/**
	 * `loading`: the provider's object started a new attempt after a failure, or its relay's upstream link dropped
	 * (`#startOver`).
	 */
	loading(): void {
		this.#startOver();
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

	/**
	 * Where an event of member `member` (an index into the bound version's event members) of its hold goes: its live
	 * binding's node for it, when something taps it; `undefined` when the value is to be dropped unopened (not live, no
	 * listener). Throws on an index outside the bound version (a protocol error).
	 */
	eventNode(member: number): EventNode | undefined {
		const bound = this.#bound;
		if (this.#state.kind !== "live" || bound === undefined) return undefined;
		const name = bound.names.events[member];
		if (name === undefined) throw new Error(`${this.label}: no event member ${member}`);
		// A name of the bound variant's event members has its node.
		const node = bound.eventNode(name)!;
		return node.tapped ? node : undefined;
	}

	/**
	 * One entry of an `event` message for its hold: the value of event member `member` stamped `at`, taking this host's
	 * next counter value, at the node its reference's subscriptions tap (`eventNode`: dropped unopened when it is not
	 * live or nothing listens); dropped past the link's limits (`too_large`, counted; the hold stays bound).
	 */
	event(member: number, at: number, value: Part, link: HostLink): void {
		const node = this.eventNode(member);
		if (node === undefined) return;
		const { events } = this.#host;
		let json: string | Uint8Array;
		try {
			json = link.openPart(value, link.limits, link.context);
		} catch (error) {
			if (!isChordError(error, "too_large")) throw error;
			events.metrics.counter("chord.events.dropped").add(1, { reason: "too_large" });
			return;
		}
		// Fresh JSON from the link: event values are never validated (as state, §30).
		events.push(node, parsePart(json) as JsonValue, at);
	}

	/**
	 * Its principal was revoked on this host (`host.revoke`): released at its provider if it is held there, then ended
	 * with `error` as `lost` does; no later link holds it.
	 */
	revoke(error: ChordError): void {
		const hold = this.#hold;
		this.#hold = undefined;
		this.#unpublish();
		hold?.side.release(hold.id, error);
		this.lost(error);
	}

	/**
	 * `gone`, or the host closes: every reference ends, their calls reject with `error`. The bindings are taken and the
	 * object ends first, so each ends exactly once whatever ending one does.
	 */
	lost(error: ChordError): void {
		const bindings = [...this.#bindings];
		this.#unpublish();
		this.#hold?.side.forget(this.#hold.id, error);
		this.#end(error);
		for (const binding of bindings) binding.end(error);
	}

	/** Ends the object: out of the table, detached from its path, replicas ended; keeps none of its references. */
	#end(error: ChordError): void {
		this.#unpublish();
		this.#held("ended");
		const bound = this.#bound;
		this.#state = { kind: "ended", error };
		this.#bindings.clear();
		this.#dependent = undefined;
		this.#hold = undefined;
		this.#bound = undefined;
		this.#path.detach(this);
		for (const replica of bound?.replicas.values() ?? []) replica.end(error);
	}

	/** Its first `bound` or failure (or its end before either): its `chord.hold` span ends with `outcome`. */
	#held(outcome: "bound" | "failed" | "ended", error?: ChordError): void {
		const holding = this.#holding;
		if (holding === undefined) return;
		this.#holding = undefined;
		if (error !== undefined) spanFailed(holding.span, "hold_failed", error);
		holding.span.setAttributes({ outcome });
		holding.end();
	}

	/**
	 * Loading again until the next binding; the members keep their last values. A drop while it is loading already
	 * changes nothing: a dependent parked on it goes on waiting for the next link's binding (a drop is not a dependency
	 * failure).
	 */
	#startOver(): void {
		const { kind } = this.#state;
		if (kind !== "ended" && kind !== "loading") this.#move(LOADING);
	}

	/**
	 * Moves to `state` and tells every binding, as a local object tells its holders: their members follow what it shows
	 * now (all in one batch), then each its state; one released meanwhile is not told. A broken failure takes it out of
	 * the sharing table first, for good: a new reference holds anew.
	 */
	#move(state: RefState): void {
		if (state.kind === "failed" && state.cause.kind === "broken") this.#unpublish();
		this.#state = state;
		if (this.#bindings.size === 0) return;
		const bindings = [...this.#bindings];
		if (bindings.some((binding) => binding.following)) {
			this.#host.batch.within(() => {
				for (const binding of bindings) binding.retarget();
			}, BACKGROUND_CONTEXT);
		} else {
			for (const binding of bindings) binding.retarget();
		}
		for (const binding of bindings) if (this.#bindings.has(binding)) binding.moved();
	}
}
