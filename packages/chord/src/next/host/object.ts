// Objects (§6): one per identity, from its first attempt to its end. Its state across attempts (its documents, line
// and job runs), the instance its references follow (`followed`: decision "References are the only indirection"), its
// holders, retries after failures (backoff, `ref.retry()`, passed
// on while parked), what it shows while its attempt is parked on dependencies (dependency model §3), its first outcome
// (the start barrier, decision (a)), a live object's failure (slice 6a §1.4), the waits and cycle checks of activations
// (Q5, its instance id and the activation chain it was created for), lingering after its last reference (§3, D8), the
// job runs that keep it alive (§15), its contributions to registries while live and its wake signals (`retryOn`, slice
// 8), its ending, revocation included (§4, R11), and what a reload does to it (slice 7b §4): a pure swap in place, a
// native restart after the drain, a retry on the new code, or its end by its type's removal, after which its
// references wait with their last values and follow the next object of the identity.

import { awaitWithContext, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { ContractShape } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { asChordError, binds, invalid, type Provider, sameCause } from "../data/internal.ts";
import { Documents, type KeyedSlot } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import { JobRecords } from "../jobs/internal.ts";
import { CHAIN } from "../link/internal.ts";
import type { RegistryContribution } from "../registries/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import { refusal } from "./adapted.ts";
import { Attempt, type PinnedKey, type Self } from "./attempt.ts";
import type { Caller } from "./ctx.ts";
import type { Dependency } from "./dependencies.ts";
import type { AnyHost } from "./host.ts";
import type { CloseFailed, NativeCloseReason } from "./native.ts";
import { type Ended, type Failed, LIVE, LOADING, type RefState } from "./ref-state.ts";
import { type CheckedParams, type Followed, type RetryWalk, retryWalk, type Target } from "./reference.ts";
import { type RetrySource, RetryWakes } from "./retry-on.ts";
import { migratesTables, type Recorded } from "./staging.ts";
import { uuidv7 } from "./uuid.ts";

/** A `local` contract, as a served type has it. */
export type LocalContract = Contract<ContractShape & { readonly kind: "local" }>;

/** A `remote` contract, as a served type has it. */
export type RemoteContract = Contract<ContractShape & { readonly kind: "remote" }>;

/**
 * A type served on a host, by kind: its contract, factory (a remote one gets the object's principal) and argument
 * checks. Factories are plugin code: what they return is checked at activation.
 */
export type Served =
	| (ServedType<LocalContract> & {
			readonly kind: "local";
			readonly factory: (params: ParamsOf<Contract>, self: Self) => unknown;
			/** A type with empty params: its object lives as long as the host (Q-A). */
			readonly hostLifetime: boolean;
	  })
	| (ServedType<RemoteContract> & {
			readonly kind: "remote";
			readonly factory: (params: ParamsOf<Contract>, principal: Principal, self: Self) => unknown;
	  });

type ServedType<C extends Contract> = {
	/** The plugin whose facet served it: its objects contribute to registries by it. */
	readonly plugin: string;
	readonly contract: C;
	readonly provider: Provider<Contract>;
	/** How long a live object stays live after its last reference, in milliseconds (`serve`'s `linger`, 0 by default). */
	readonly linger: number;
};

/** What holds an object: a reference's binding, or a hold arriving over a link. */
export interface Holder {
	/** The object whose attempt declared the reference: it checks its dependencies again when this object changes. */
	readonly dependent: ChordObject | undefined;
	/** Whom the reference acts for, with its origin's incarnation (`host.references`). */
	readonly caller: Caller;
	/** The consumer's contract version and fingerprint (its request's): the provider binds it or it waits unbound. */
	readonly contract: { readonly version: number; readonly fingerprint: string };
	/**
	 * Inside a batch, before `moved`: what it follows of the object changed (`ChordObject.followed`): a reference moves its
	 * members' subscriptions to the new instance, or keeps their last values; a hold over a link has nothing to do here.
	 */
	retarget(): void;
	/** Whether `retarget` moves anything (a reference whose members or keys were used): it then runs in a batch. */
	readonly following: boolean;
	/** The object's state (`state`) changed: an attempt started after a failure, it went live, or it failed. */
	moved(): void;
	/** The object ended with `error`. */
	end(error: ChordError): void;
	/**
	 * The object ended because a reload removed its type (slice 7b §6): the holder's request is not ended; it waits
	 * unbound with `removal.cause` (`not_served`) until a publication serves the name again.
	 */
	removed(removal: Removal): void;
}

/**
 * What an object tells holders it leaves: why they wait (`not_served` after a removal, `contract_mismatch` after a
 * version refusal), its params (they place their requests again) and its context. A reference keeps its last values
 * meanwhile and moves its subscriptions to the next object of the identity that serves its version (one frame).
 */
export type Removal = {
	readonly cause: FailureCause;
	readonly host: AnyHost;
	readonly params: CheckedParams;
	readonly context: Context;
};

/** What a reload does to a live, activating, parked or failed object whose type is still served (slice 7b §4). */
export type ReloadFate = "swap" | "restart" | "retry";

/**
 * A pure swap in progress (slice 7b §5): the attempt it replaces (its calls run on, then it is sealed), whether the new
 * attempt parked (holders then see what it shows, and the old one's contributions left the tables), and the end of
 * the swap (its new attempt live, parked or failed, or the object ended), which calls arriving meanwhile wait for.
 */
type Swap = { readonly old: Attempt; parked: boolean; readonly done: PromiseWithResolvers<void> };

/**
 * Where an object stands. `waiting`: for its identity's backoff window before its first attempt. `activating` has what
 * its references show: `loading`, or `failed { waiting }` while its attempt is parked on a failed dependency. `failed`
 * has the state its references show.
 */
type ObjectState =
	| { readonly kind: "waiting" }
	| {
			readonly kind: "activating";
			readonly attempt: Attempt;
			readonly shown: RefState;
			/** Set while a reload's pure swap replaces the live attempt. */
			readonly swap?: Swap;
	  }
	| { readonly kind: "live"; readonly attempt: Attempt }
	| { readonly kind: "failed"; readonly failure: Failed }
	| { readonly kind: "ended"; readonly ended: Ended };

/**
 * What an ended object still has to do once its previous teardowns finished (`previous`): drain and close its attempt;
 * then drop its documents and job runs (`end` alone).
 */
type Teardown =
	| { readonly kind: "none" }
	| { readonly kind: "end"; readonly previous: Promise<void> | undefined }
	| { readonly kind: "close"; readonly attempt: Attempt; readonly previous: Promise<void> | undefined };

/** How an object ends: by an end (its last reference, revocation, the host closing) or by its type's removal. */
type Ending =
	| { readonly kind: "end"; readonly error: ChordError }
	| { readonly kind: "removed"; readonly error: ChordError; readonly cause: FailureCause };

const END: NativeCloseReason = { kind: "end" };

const CLOSE: NativeCloseReason = { kind: "close" };

const RELOAD: NativeCloseReason = { kind: "reload" };

/** No dependencies waited for: the shared empty list. */
const NO_DEPENDENCIES: readonly Dependency[] = [];

/** No contributions leaving: the shared empty list. */
const NO_CONTRIBUTIONS: readonly RegistryContribution[] = [];

/**
 * One object. Each attempt is a fresh `Attempt`; the documents, the line, the job runs and the holders outlive it. An
 * attempt parked on its dependencies waits for them without a timer; a transient failure (its own) is retried after its
 * backoff window, or at once when a reference asks (`retry`); a broken one stays failed until a reference asks.
 * The object ends with its last reference, a live one after its type's `linger` (never, for a host-lifetime object),
 * or when the host closes.
 */
export class ChordObject implements Target {
	readonly host: AnyHost;
	/** Its served type: replaced by a reload that swaps, restarts or retries it. */
	served: Served;
	readonly params: ParamsOf<Contract>;
	/** Its params' identity key (empty for empty params). */
	readonly key: string;
	/** The principal in a remote object's identity, which its factory gets; `undefined` for a local object. */
	readonly principal: Principal | undefined;
	readonly identity: string;
	/** The object in errors, reports and cycles: its type, and its params key when it has params. */
	readonly label: string;
	/**
	 * The activation chain it was created for (Q5): the instance ids of the activations waiting for it, from the hold
	 * that created it (a trusted link's) or the activation here that declared it; empty otherwise.
	 */
	readonly chain: readonly string[];
	/** Its documents and line, across its attempts. */
	readonly documents: Documents;
	/** The context of every attempt: its creator's, without the creator's cancellation. */
	readonly #context: Context;
	/** Its job runs by job name, across its attempts. */
	readonly #jobs = new Map<string, JobRecords>();
	/** This instance's id (uuidv7), minted at its first attempt: a restarted object is a new instance (D4). */
	#instance: string | undefined;
	#state: ObjectState = { kind: "waiting" };
	/** References and holds of this object. */
	readonly #holders = new Set<Holder>();
	/** The dependencies its parked attempt waits for; their objects are followed to find cycles (Q5). */
	#waitingFor: readonly Dependency[] = NO_DEPENDENCIES;
	/**
	 * Its first outcome (decision (a)): live, failed, parked with no blocker here still without one, or ended; once.
	 * The promise is made by the first who waits for it (the start barrier, for host-lifetime objects).
	 */
	#firstOutcome: PromiseWithResolvers<void> | undefined;
	#hasFirstOutcome = false;
	/** The error of the last failed attempt, or the last cause a parked attempt showed, until one goes live. */
	#lastFailure: ChordError | undefined;
	/** Ends the object when its type's `linger` passed after its last reference; cleared by a new one. */
	#lingering: ReturnType<typeof setTimeout> | undefined;
	/** Its running and finishing job runs: they keep it alive like references (D4), without being references. */
	#runs = 0;
	/**
	 * The instance its references follow (`followed`): the live one, the old one while a swap brings its successor in
	 * place, or the last one that went live while it still changes after a failure or a restart (references take their
	 * last values from it when it stops); `undefined` before the first went live and once it stopped changing.
	 */
	#exposed: Attempt | undefined;
	/**
	 * Whether references still follow `#exposed`, which may still change: while it is live, drains (a restart), retires
	 * (a swap's old instance until its successor is live or it retired), or failed live until the commits admitted
	 * before it published (every member, its own and re-exposed ones: audit A10); not once it stopped changing.
	 */
	#following = false;
	/** The one timer storing its jobs' held state changes by their earliest deadline (D8), while one is held. */
	#flush: { readonly deadline: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	/** Its wake signals (`retryOn`), the last attempt's declaration; made by the first. */
	#wakes: RetryWakes | undefined;
	/** Its swapped-out attempts while they retire (bounded by `closeTimeout`); made by the first swap. */
	#retiring: Map<Attempt, Promise<void>> | undefined;

	constructor(
		host: AnyHost,
		served: Served,
		params: ParamsOf<Contract>,
		principal: Principal | undefined,
		key: string,
		identity: string,
		context: Context,
		chain: readonly string[],
	) {
		this.host = host;
		this.served = served;
		this.params = params;
		this.principal = principal;
		this.key = key;
		this.identity = identity;
		this.label = key === "" ? served.contract.name : `${served.contract.name}(${key})`;
		this.chain = chain;
		this.#context = context;
		const { store } = host;
		this.documents = new Documents({
			label: this.label,
			batch: host.batch,
			context,
			store: store === undefined ? undefined : { store, owner: served.contract.name },
			fail: (error) => {
				if (this.#state.kind === "live") this.failLive(this.#state.attempt, { kind: "broken", error });
			},
		});
	}

	/** The object's state as its references show it. */
	get state(): RefState {
		const state = this.#state;
		if (state.kind === "failed") return state.failure;
		if (state.kind === "live") return LIVE;
		if (state.kind === "ended") return state.ended;
		return state.kind === "activating" ? state.shown : LOADING;
	}

	/** Whether its state members have values: once live (a local object stays live until it ends). */
	get hydrated(): boolean {
		return this.#state.kind === "live";
	}

	/** Resolves at its first outcome (the start barrier waits for it); never rejects. */
	get firstOutcome(): Promise<void> {
		if (this.#hasFirstOutcome) return Promise.resolve();
		this.#firstOutcome ??= Promise.withResolvers<void>();
		return this.#firstOutcome.promise;
	}

	/** Whether it holds up the start barrier: it has no first outcome yet. */
	get blocksFirstPass(): boolean {
		return !this.#hasFirstOutcome;
	}

	/**
	 * The error of its last failure while none went live since: a failed attempt's, or the cause its parked attempt
	 * showed last (kept when the dependency falls back to `loading`, so a getter's deadline names it).
	 */
	get lastFailure(): ChordError | undefined {
		return this.#lastFailure;
	}

	/** Its instance id while an attempt activates; `undefined` otherwise (a hold's chain names only activations). */
	get activationId(): string | undefined {
		return this.#state.kind === "activating" ? this.#instance : undefined;
	}

	/**
	 * The chain a hold this object's activation makes over a link carries (Q5): its own chain and its instance id, the
	 * last 32; `undefined` when it is not activating.
	 */
	activationChain(): string[] | undefined {
		const id = this.activationId;
		if (id === undefined) return undefined;
		const { chain } = this;
		return [...(chain.length < CHAIN ? chain : chain.slice(chain.length - CHAIN + 1)), id];
	}

	/** Its holders, for a presence list made after they took it. */
	get holders(): ReadonlySet<Holder> {
		return this.#holders;
	}

	/** The variant a live remote object's factory chose; `undefined` for a local object and before it is live. */
	get variant(): string | undefined {
		return this.#state.kind === "live" ? this.#state.attempt.variant : undefined;
	}

	/** The live object's state members, as Chord follows them. */
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#live().stateMembers;
	}

	/**
	 * Starts an attempt when waiting or failed and returns it; a trigger while an attempt runs (or once live) is ignored.
	 * After a failure the holders are told: their references are loading again.
	 */
	attempt(): Attempt | undefined {
		const state = this.#state;
		if (state.kind !== "waiting" && state.kind !== "failed") return undefined;
		this.#instance ??= uuidv7();
		const attempt = new Attempt(this, this.#context);
		this.#state = { kind: "activating", attempt, shown: LOADING };
		if (state.kind === "failed") this.#notify();
		void this.#run(attempt, this.host.endingOf(this.identity));
		return attempt;
	}

	/**
	 * `ref.retry()` and a `retry` message, as a step of `walk` (handled once per walk: a diamond reaches it twice): an
	 * attempt now when failed (a broken one too) or waiting, its backoff window skipped; passed on to the failed
	 * dependencies while parked `failed { waiting }`; ignored otherwise (an attempt runs, or it is live).
	 */
	retry(walk: RetryWalk = retryWalk()): void {
		if (walk.visited.has(this)) return;
		walk.visited.add(this);
		const state = this.#state;
		if (state.kind === "activating") {
			if (state.shown.kind === "failed") state.attempt.retryDependencies(walk);
			return;
		}
		if (state.kind !== "waiting" && state.kind !== "failed") return;
		this.host.backoff.skip(this.identity);
		this.attempt();
	}

	/**
	 * Follows `sources` as its wake signals instead of the last attempt's (`self.retryOn`, right after a factory
	 * returned): a new value retries it while failed, as `ref.retry()` does; one while it activates retries it at once
	 * if that attempt fails; one while live does nothing.
	 */
	retryOn(sources: readonly RetrySource[]): void {
		if (this.#wakes === undefined && sources.length === 0) return;
		this.#wakes ??= new RetryWakes();
		this.#wakes.replace(sources, () => this.#wake());
	}

	/**
	 * Calls a method of the live object for `caller`, bound at `version` (an older one maps its arguments and result,
	 * Q10). While a reload's pure swap runs, the call waits for its new attempt (the gate), bounded by `readyTimeout`.
	 */
	async call(method: string, args: unknown, context: Context, caller: Caller, version: number): Promise<unknown> {
		const state = this.#state;
		if (state.kind === "activating" && state.swap !== undefined) await this.#gate(state.swap, context);
		return this.#live().call(method, args, context, caller, version);
	}

	/**
	 * Whether a reload's pure swap runs in place: the new attempt neither parked nor failed yet. Holds stay bound
	 * meanwhile (their calls wait at the gate) and get a fresh `bound` once it is live.
	 */
	get swapsInPlace(): boolean {
		const state = this.#state;
		return state.kind === "activating" && state.swap !== undefined && !state.swap.parked;
	}

	/** Whether a consumer of `contract`'s version and fingerprint binds to this object's provider now (R6, Q10). */
	binds(contract: Contract): boolean {
		return binds(this.served.provider, contract.version, contract.fingerprint);
	}

	/** Its params as checked, with their identity key. */
	get checkedParams(): CheckedParams {
		return { params: this.params, key: this.key };
	}

	/**
	 * What a reference of `version` follows for state member `member` now (decision "References are the only
	 * indirection"): the shown instance's member (its mapping at an older version) while that instance is live, while a
	 * swap brings its successor in place, and after a live failure until its admitted commits published; else nothing:
	 * `failed` with the cause's error, or `loading`, with that member to take a last value from.
	 */
	followed(member: string, version: number): Followed {
		const exposed = this.#exposed;
		let shown: DeriveSource | undefined;
		let lacking: ChordError | undefined;
		if (exposed !== undefined) {
			try {
				shown = exposed.memberAt(member, version);
			} catch (error) {
				const failure = asChordError(error, this.label);
				// The shown instance does not serve this version (a swap's old one, while a reload brings it): nothing yet.
				if (failure.code !== "contract_mismatch") lacking = failure;
			}
		}
		if (exposed !== undefined && this.#following) {
			if (shown !== undefined) return { kind: "live", source: shown, instance: exposed };
			if (lacking !== undefined) return { kind: "lacking", error: lacking };
			return { kind: "loading", last: undefined, instance: undefined };
		}
		const state = this.#state;
		const failure =
			state.kind === "failed"
				? state.failure
				: state.kind === "activating" && state.shown.kind === "failed"
					? state.shown
					: undefined;
		if (failure !== undefined) return { kind: "failed", error: failure.cause.error, last: shown, instance: exposed };
		return { kind: "loading", last: shown, instance: exposed };
	}

	/**
	 * The instance its references follow now (they attach to it; they take last values only from an instance they
	 * attached to); `undefined` once it stopped changing.
	 */
	get attachable(): Attempt | undefined {
		return this.#following ? this.#exposed : undefined;
	}

	/** The live instance, which references pin their keys on (a new one: they pin again); `undefined` when not live. */
	get instance(): Attempt | undefined {
		return this.#state.kind === "live" ? this.#state.attempt : undefined;
	}

	/** The live instance's state member `member` as a consumer of `version` follows it (a hold over a link). */
	liveMember(member: string, version: number): DeriveSource {
		return this.#live().memberAt(member, version);
	}

	/** How a consumer of `version` reads keyed member `member`'s documents: mapped back when older (`undefined`: as they are). */
	keyedMapping(member: string, version: number): ((current: JsonValue) => JsonValue) | undefined {
		return this.#live().keyMapping(member, version);
	}

	/** Waits until `swap` ended (its new attempt live, parked, failed, or the object ended). */
	async #gate(swap: Swap, context: Context): Promise<void> {
		// No timer of its own: the swap ends when its new attempt is live, parked or failed, and `readyTimeout` bounds
		// the new attempt's own steps (Fable).
		await awaitWithContext(swap.done.promise, context);
	}

	/** The keyed member `member` of the live object: its ultimate slot (slice 6a §12). */
	keyedMember(member: string): KeyedSlot {
		return this.#live().keyedMember(member);
	}

	/** Pins `key` of keyed member `member` on the live instance, as a consumer of `version` reads it (`Attempt.pinKey`). */
	pinKey(member: string, key: string, version: number, context: Context): Promise<PinnedKey> {
		return this.#live().pinKey(member, key, version, context);
	}

	/**
	 * Counts `holder` as a reference to this object (the holder reads `state` itself), listed in its type's presence; a
	 * lingering object stays.
	 */
	hold(holder: Holder): void {
		// A version it binds whose member the live provider refuses (an older consumer): it waits unbound instead.
		const state = this.#state;
		const unfit = state.kind === "live" ? this.#unfit(holder, state.attempt) : undefined;
		if (unfit !== undefined) {
			this.#unbound(holder, unfit);
			return;
		}
		this.#holders.add(holder);
		this.#stopLingering();
		// Last: a derive over the presence list may close a link synchronously, which may release this holder again.
		this.host.referenced(this, holder, this.#context);
	}

	/** `holder` was released: the object may end (`#idle`). */
	unhold(holder: Holder): void {
		if (!this.#holders.delete(holder)) return;
		this.#dropUnheld(holder.contract.version);
		this.#idle();
		// Last: a derive over the presence list may close a link synchronously, which releases other holders again.
		this.host.unreferenced(this, [holder], this.#context);
	}

	/**
	 * The records of job `definition`'s runs, made by its first declaration. A later declaration (a new attempt's, after a
	 * reload) at another version takes the records over (each run keeps its version, slice 7b §8); one at the same
	 * version with another fingerprint is refused (`checkJob`).
	 */
	jobRecords(definition: JobDefinition<unknown, unknown, unknown>): JobRecords {
		const records = this.#jobs.get(definition.name);
		if (records === undefined) {
			const { store } = this.host;
			const owner = {
				label: this.label,
				host: this.host,
				context: this.#context,
				documents: this.documents,
				store: store === undefined ? undefined : { store, owner: this.served.contract.name },
				countRuns: (delta: number) => this.countRuns(delta),
				held: (deadline: number) => this.#heldUntil(deadline),
			};
			const made = new JobRecords(definition, owner);
			this.#jobs.set(definition.name, made);
			return made;
		}
		this.checkJob(definition);
		records.redefine(definition);
		return records;
	}

	/** Refuses a declaration of a job its records cannot take (`JobRecords.check`); a reload's staging checks it too. */
	checkJob(definition: JobDefinition<unknown, unknown, unknown>): void {
		this.#jobs.get(definition.name)?.check(definition);
	}

	/**
	 * Claims table `table` (its SQL name) in the host's store for this object, until its end (slice 6b claims); held by
	 * another owner: `invalid/args`, which fails the declaring factory.
	 */
	claimTable(table: string): void {
		this.host.store!.claims.table(table, this);
	}

	/** Claims this object's documents in `namespace` of the host's store, as `claimTable`. */
	claimDocuments(namespace: string): void {
		this.host.store!.claims.documents(this.served.contract.name, namespace, this);
	}

	/**
	 * A runtime failure of the live attempt `attempt`: `broken` (a `migrate` failing on access, a stored version newer
	 * than the code, a refused commit) or `transient` (a followed runtime failed, R4): the attempt is sealed and the
	 * object `failed` with `cause`; calls reject with it, holders are told, its references keep their last values once the
	 * admitted commits adopted (`followed`), the natives close in the background (then its references are released),
	 * `onError` gets `object_failed` once. Documents and job runs stay. Recovery: a broken failure by `ref.retry()`, a
	 * transient one after its identity's backoff too (a new attempt, whose members its references follow once live). A
	 * failure of a sealed attempt is ignored, so several at once fail it once.
	 */
	failLive(attempt: Attempt, cause: FailureCause): void {
		const state = this.#state;
		if (state.kind !== "live" || state.attempt !== attempt) return;
		const { error } = cause;
		if (cause.kind === "transient") this.host.backoff.failed(this.identity);
		else this.host.backoff.delete(this.identity);
		const failure: Failed = { kind: "failed", cause, retryAt: this.host.backoff.until(this.identity) };
		this.#state = { kind: "failed", failure };
		this.#lastFailure = error;
		this.#withdraw(attempt);
		attempt.seal(error);
		// Its references follow every member on until the commits admitted before the seal adopted and published once
		// (frames included), then stop. A retry's factory and hydration wait for both (its ending), so no old commit
		// lands in a new attempt.
		const frozen = this.documents.settled().then(() => this.#stopFollowing(attempt));
		const closing = Promise.all([attempt.close(END), frozen]).then(([failures]) => {
			attempt.detach();
			attempt.releaseReferences();
			return failures;
		});
		this.host.ending(this.identity, this.#reported(closing));
		this.host.report({ kind: "object_failed", object: this.label, failure: cause });
		this.#notify();
		this.#idle();
	}

	/** A held state change must be stored by `deadline`: the timer is set for the earliest one. */
	#heldUntil(deadline: number): void {
		if (this.#flush !== undefined && this.#flush.deadline <= deadline) return;
		if (this.#flush !== undefined) clearTimeout(this.#flush.timer);
		// A foreground timer: what is held is stored before the process may exit.
		const timer = setTimeout(() => void this.#flushHeld(), Math.max(0, deadline - Date.now()));
		this.#flush = { deadline, timer };
	}

	/** The timer fired: every held change past its deadline is stored, and the timer set for the next one. */
	async #flushHeld(): Promise<void> {
		this.#flush = undefined;
		if (this.#state.kind === "ended") return;
		const now = Date.now();
		const jobs = [...this.#jobs.values()];
		await Promise.all(jobs.map((records) => records.flushHeld(now)));
		const next = Math.min(...jobs.map((records) => records.nextDeadline()));
		if (Number.isFinite(next)) this.#heldUntil(next);
	}

	/**
	 * Adds `delta` to its running and finishing job runs (and `host.activity.jobs`). A new run keeps a lingering object;
	 * the last one settling on an object without references ends it as its last release would (`#idle`).
	 */
	countRuns(delta: number): void {
		this.#runs += delta;
		this.host.count("jobs", delta);
		// A run started while the object lingers keeps it, like a new reference.
		if (delta > 0) this.#stopLingering();
		if (this.#runs === 0) this.#idle();
	}

	/**
	 * Throws `invalid/cycle` when waiting for `dependency` closes a chain of waits back to this object (Q5). Every other
	 * object on the chain fails broken with the same error, so no part of a cycle waits for a retry. Counts the objects
	 * it visits (`chord.cycle.visits`). Otherwise, a dependency whose activation is in this object's chain closes a
	 * cycle through other hosts (they fail through their dependency on this one).
	 */
	assertNoCycle(dependency: Target, context: Context): void {
		const visited = new Set<Target>();
		const cycle = dependency.pathTo(this, visited);
		context.telemetry.metrics?.counter("chord.cycle.visits").add(visited.size);
		if (cycle === undefined) {
			const across = dependency.activationId;
			if (across === undefined || !this.chain.includes(across)) return;
			throw this.host.cycle(this.chain, across, [this.label, dependency.label]);
		}
		const error = invalid("cycle", `dependency cycle: ${[this, ...cycle].map(({ label }) => label).join(" → ")}`);
		for (const object of cycle) {
			const state = object.#state;
			if (object !== this && state.kind === "activating") {
				state.attempt.abandon({ kind: "failed", cause: { kind: "broken", error } });
			}
		}
		throw error;
	}

	/** Its parked attempt waits for `dependencies` (none once it leaves parking): the waits a cycle check follows. */
	waitsFor(dependencies: readonly Dependency[]): void {
		this.#waitingFor = dependencies;
	}

	/**
	 * A dependency of its current attempt changed (its state, or its first outcome): a parked attempt checks again; an
	 * attempt past its dependency check ignores it (R18 after live), and so does any other state.
	 */
	dependencyMoved(): void {
		const state = this.#state;
		if (state.kind === "activating") state.attempt.dependencyMoved();
	}

	/**
	 * Its attempt `attempt` is parked showing `shown` (`loading` or `failed { waiting }`): holders are told when that
	 * changed (a cause compared by value). `firstPass`: no blocker here is still without its first outcome, so this
	 * object has its first outcome now.
	 */
	parked(attempt: Attempt, shown: RefState, firstPass: boolean): void {
		const state = this.#state;
		if (state.kind !== "activating" || state.attempt !== attempt) return;
		const { swap } = state;
		// A swap's new attempt parks (decision 4): no overlap of old and new code, holders see what it shows.
		const parks = swap !== undefined && !swap.parked;
		if (parks) this.#swapParked(swap);
		if (parks || !sameState(state.shown, shown)) {
			this.#state = { kind: "activating", attempt, shown, ...(swap === undefined ? {} : { swap }) };
			if (shown.kind === "failed") this.#lastFailure = shown.cause.error;
			this.#notify();
		}
		if (firstPass) this.#settleFirstOutcome();
	}

	/** Its attempt `attempt` left parking for its own steps: it shows `loading` until its outcome. */
	unparked(attempt: Attempt): void {
		const state = this.#state;
		if (state.kind !== "activating" || state.attempt !== attempt) return;
		if (!sameState(state.shown, LOADING)) this.parked(attempt, LOADING, false);
	}

	/** A swap's new attempt parked: the old attempt's contributions leave the tables (it is not live any more). */
	#swapParked(swap: Swap): void {
		swap.parked = true;
		this.#withdraw(swap.old);
		swap.done.resolve();
	}

	/**
	 * Ends the object (once): sealed now, its holders and running calls told `error` (`released` by default), torn down
	 * in the background with reason `end`, close failures reported.
	 */
	end(error: ChordError = this.ended()): void {
		const teardown = this.#seal({ kind: "end", error });
		if (teardown.kind !== "none") this.host.ending(this.identity, this.#reported(this.#tearDown(teardown, END)));
	}

	/**
	 * Ends the object for `host.close`: sealed now; returns its teardown (reason `close`), which the host runs once every
	 * object is sealed, so no reference it releases starts an ending in the background.
	 */
	stop(): () => Promise<CloseFailed[]> {
		const teardown = this.#seal({ kind: "end", error: this.ended() });
		return () => this.#tearDown(teardown, CLOSE);
	}

	/**
	 * Ends the object because a reload removed its type (slice 7b §4): as `end` (natives close with reason `end`,
	 * running calls' callers rejected `released`, handlers drained), but its holders' requests are not ended: they wait
	 * unbound with `cause` (`not_served`), references with their last values, until the next object of its identity
	 * binds them (`Removal`).
	 */
	remove(cause: FailureCause): void {
		const teardown = this.#seal({ kind: "removed", error: this.ended(), cause });
		if (teardown.kind !== "none") this.host.ending(this.identity, this.#reported(this.#tearDown(teardown, END)));
	}

	/**
	 * What a reload with `recorded` (the new factory's declarations) does to this object, whose type is still served:
	 * a live object swaps in place when neither its live attempt nor the new factory opens natives and no table of the
	 * new factory is newer than the store's, else it restarts; any other is retried.
	 */
	reloadFate(recorded: Recorded): ReloadFate {
		const state = this.#state;
		if (state.kind !== "live") return "retry";
		if (state.attempt.opensNatives || recorded.natives > 0 || migratesTables(this, recorded)) return "restart";
		return "swap";
	}

	/**
	 * Takes `fate` with its new served type (after the reload's commit); returns the new attempt, whose first
	 * dependency check the reload's report waits for.
	 */
	reload(served: Served, fate: ReloadFate): Attempt {
		// Its members per version stay: the previous version's are mapped once the new attempt goes live.
		this.served = served;
		const attempt = fate === "swap" ? this.#swap() : fate === "restart" ? this.#restart() : this.#retryReloaded();
		attempt.startedByReload();
		return attempt;
	}

	/**
	 * A pure swap (slice 7b §5): a new attempt of the same object (its documents, line and job records, its instance id),
	 * its activation at once; the live attempt keeps its running calls, its routines aborted, its jobs handed over,
	 * and is sealed once its calls settled and the new attempt's requests bound (`#retire`). Calls arriving meanwhile
	 * wait at the gate.
	 */
	#swap(): Attempt {
		// A swap starts from a live object (`reloadFate`).
		const old = (this.#state as Extract<ObjectState, { readonly kind: "live" }>).attempt;
		const ending = this.host.endingOf(this.identity);
		const attempt = new Attempt(this, this.#context);
		const swap: Swap = { old, parked: false, done: Promise.withResolvers() };
		this.#state = { kind: "activating", attempt, shown: LOADING, swap };
		old.handOver();
		this.#retiringAdd(old, this.#retire(swap));
		this.#notify();
		void this.#run(attempt, ending);
		return attempt;
	}

	/**
	 * Keeps `retire` (a swapped-out attempt's) until it settled: a restart, an end and the host's close wait for it; a
	 * later swap does not (it holds no natives, its documents are the object's: Fable, Opus F1), so a second reload is
	 * never held up by the first one's old calls.
	 */
	#retiringAdd(old: Attempt, retire: Promise<void>): void {
		this.#retiring ??= new Map();
		const retiring = this.#retiring;
		retiring.set(old, retire);
		void retire.finally(() => {
			retiring.delete(old);
		});
	}

	/** Its swapped-out attempts still retiring, as one wait; `undefined` when none is. */
	#retiringNow(): Promise<void> | undefined {
		const retiring = this.#retiring;
		if (retiring === undefined || retiring.size === 0) return undefined;
		return Promise.all(retiring.values()).then(() => {});
	}

	/**
	 * Seals a swapped attempt once its running calls (and routine calls) settled, bounded by `closeTimeout`, and the swap
	 * ended (the new attempt live, parked, failed: its requests bound, so no request it shares with the old one ends in
	 * between, M§3.9, and its holders compared the old members with the new); a parked swap's references take their last
	 * values from it once the commits it admitted before the seal published; then its references are released. Its job
	 * invocations run on, on their old code.
	 */
	async #retire({ old, done }: Swap): Promise<void> {
		await Promise.all([old.drainCalls(), done.promise]);
		old.seal(this.#reloaded());
		// A parked swap's old instance stops changing once its admitted commits published (its successor, live, took over
		// its references before).
		await this.documents.settled();
		this.#stopFollowing(old);
		const failures = await old.close(END);
		old.detach();
		old.releaseReferences();
		for (const failure of failures) this.host.report(failure);
	}

	/**
	 * A native restart (decision "A native restart drains first"): new calls park (it shows `loading`), its
	 * contributions leave, the live attempt's running calls drain (bounded by `closeTimeout`), then it is sealed (its
	 * in-memory job runs end `aborted { reload }`), its references take their last values once its admitted commits
	 * published, its natives close with reason `reload`; the new attempt, a new instance (D4), activates after that
	 * teardown.
	 */
	#restart(): Attempt {
		const old = (this.#state as Extract<ObjectState, { readonly kind: "live" }>).attempt;
		this.#withdraw(old);
		old.stopRoutines();
		this.#instance = uuidv7();
		const teardown = (async () => {
			await Promise.all([old.drainCalls(), this.#retiringNow()]);
			old.seal(this.#reloaded(), "reload");
			// Drained and sealed: its references take their last values once the commits it admitted before published
			// (a store write is not a running call's promise; Sol).
			await this.documents.settled();
			this.#stopFollowing(old);
			const failures = await old.close(RELOAD);
			old.detach();
			old.releaseReferences();
			return failures;
		})();
		this.host.ending(this.identity, this.#reported(teardown));
		const attempt = this.#replace();
		void this.#run(attempt, this.host.endingOf(this.identity));
		return attempt;
	}

	/**
	 * A reload retries an object that is not live (slice 7b §9, decision 1): a parked attempt is replaced in one
	 * handover (it opened nothing: the new attempt's requests bind before the old ones are released, M§3.9); an attempt
	 * in its own steps is sealed, its natives close with reason `reload`, and the new one activates after that teardown;
	 * a failed or waiting one gets an attempt now, its backoff skipped.
	 */
	#retryReloaded(): Attempt {
		const state = this.#state;
		if (state.kind === "activating") {
			const { attempt: old, swap } = state;
			if (swap !== undefined && !swap.parked) this.#swapParked(swap);
			swap?.done.resolve();
			const parked = old.isParked;
			// A parked attempt's successor waits for no teardown of it (its references are released after it bound).
			const ending = this.host.endingOf(this.identity);
			old.seal(this.#reloaded(), "reload");
			const attempt = this.#replace();
			if (parked) void this.#run(attempt, ending);
			const after = parked ? attempt.checked : Promise.resolve();
			const closing = after
				.then(() => old.close(RELOAD))
				.then((failures) => {
					old.detach();
					old.releaseReferences();
					return failures;
				});
			this.host.ending(this.identity, this.#reported(closing));
			if (!parked) void this.#run(attempt, this.host.endingOf(this.identity));
			return attempt;
		}
		this.host.backoff.skip(this.identity);
		// Waiting or failed (`reloadFate`): an attempt starts.
		return this.attempt()!;
	}

	/** A new attempt replacing the current one, holders told; its caller starts it (`#run`) after what it waits for. */
	#replace(): Attempt {
		const attempt = new Attempt(this, this.#context);
		this.#state = { kind: "activating", attempt, shown: LOADING };
		this.#notify();
		return attempt;
	}

	/** The `released` error of an attempt a reload replaced. */
	#reloaded(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: replaced by a reload` });
	}

	/** The `released` error of this object. */
	ended(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: ended` });
	}

	/** Runs `attempt`'s activation once `ending` (its predecessors' teardowns, if any) finished; takes its outcome. */
	async #run(attempt: Attempt, ending: Promise<void> | undefined): Promise<void> {
		const outcome = await attempt.activate(ending);
		// The object may have ended after the activation's last step.
		if (this.#state.kind !== "activating" || this.#state.attempt !== attempt) return;
		switch (outcome.kind) {
			case "live":
				return this.#wentLive(attempt);
			case "failed":
				return this.#failed(attempt, outcome.cause);
		}
	}

	#wentLive(attempt: Attempt): void {
		if (this.#wakes !== undefined) this.#wakes.during = undefined;
		const swap = this.#swapOf(attempt);
		// Before the new instance is shown: holders of a version its provider does not bind leave with their last values,
		// which their references take from the instance shown so far.
		const unbound = this.#unbindUnfit(attempt);
		this.#state = { kind: "live", attempt };
		this.#exposed = attempt;
		this.#following = true;
		const { contributions } = attempt;
		// The old attempt's contributions leave in the batch the new ones enter (slice 7b §5), so no reader sees a gap.
		const leaving = swap !== undefined && !swap.parked ? swap.old.contributions : NO_CONTRIBUTIONS;
		// In the registries' tables before anyone sees it live (a getter released now reads them recomposed).
		if (contributions.length > 0 || leaving.length > 0) {
			this.host.batch.within(() => {
				for (const contribution of leaving) contribution.record.remove(contribution);
				for (const contribution of contributions) contribution.record.add(contribution);
			}, this.#context);
		}
		this.#lastFailure = undefined;
		this.host.wentLive(this);
		// Its references move to the new instance (one frame each); holds get a fresh `bound`.
		this.#notify();
		this.#settleFirstOutcome();
		swap?.done.resolve();
		// A swap's routines start once the old attempt's routine calls finished (the handover, §14).
		attempt.live(swap?.old);
		this.#takeJobs(attempt);
		// Its last holders may have left for their version: it ends as at their release.
		if (unbound) this.#idle();
	}

	/**
	 * After `attempt` went live: the jobs it does not declare block their runs (slice 7b §8); after a reload, the blocked
	 * runs of the jobs it declares are retried.
	 */
	#takeJobs(attempt: Attempt): void {
		if (this.#jobs.size === 0) return;
		const reloaded = attempt.reloadStarted;
		for (const [name, records] of this.#jobs) {
			if (!attempt.declaresJob(name)) records.undeclare();
			else if (reloaded) void records.retryBlocked(this.#context);
		}
	}

	/**
	 * Its holders whose version `attempt`'s provider (going live) does not bind (a reload dropped it, slice 7b §6), or
	 * of which it refuses a member (`contract_mismatch`), leave it: they wait unbound `version` (`failed { waiting }`),
	 * references with their last values, until a publication serves their version again. The object and its other
	 * holders stay.
	 */
	#unbindUnfit(attempt: Attempt): boolean {
		let unfit: [Holder, ChordError][] | undefined;
		for (const holder of this.#holders) {
			const error = this.#unfit(holder, attempt);
			if (error === undefined) continue;
			unfit ??= [];
			unfit.push([holder, error]);
		}
		if (unfit === undefined) return false;
		for (const [holder] of unfit) this.#holders.delete(holder);
		this.host.unreferenced(
			this,
			unfit.map(([holder]) => holder),
			this.#context,
		);
		for (const [holder, error] of unfit) this.#unbound(holder, error);
		return true;
	}

	/** Whether a holder of `version` holds it. */
	#heldAt(version: number): boolean {
		for (const holder of this.#holders) if (holder.contract.version === version) return true;
		return false;
	}

	/**
	 * Why `holder` cannot bind to `attempt` (live): its version is not one the provider binds, or the provider refuses a
	 * member of it (`contract_mismatch`); `undefined` when it binds.
	 */
	#unfit(holder: Holder, attempt: Attempt): ChordError | undefined {
		const { contract, provider } = this.served;
		const { version, fingerprint } = holder.contract;
		if (version === contract.version && fingerprint === contract.fingerprint) return undefined;
		if (binds(provider, version, fingerprint)) return refusal(this.served, version, attempt.variant);
		return new ChordError({ code: "contract_mismatch", message: `${contract.name} v${version} is not served here` });
	}

	/**
	 * `holder` (no longer held) waits unbound with `error` (`failed { waiting }`) until a publication fits it.
	 */
	#unbound(holder: Holder, error: ChordError): void {
		const cause: FailureCause = { kind: "waiting", error };
		holder.removed({ cause, host: this.host, params: this.checkedParams, context: this.#context });
	}

	/** The swap `attempt` (still the current one) ends: `undefined` when it is no swap's new attempt. */
	#swapOf(attempt: Attempt): Swap | undefined {
		const state = this.#state;
		return state.kind === "activating" && state.attempt === attempt ? state.swap : undefined;
	}

	/**
	 * Records a failed attempt: reported, torn down in the background (reason `end`), its references released once its
	 * natives closed, its holders told. Transient: a backoff window, whose end is the failure's `retryAt`; broken: no
	 * automatic retry.
	 */
	#failed(attempt: Attempt, cause: FailureCause): void {
		const swap = this.#swapOf(attempt);
		if (swap !== undefined && !swap.parked) this.#swapParked(swap);
		swap?.done.resolve();
		const wokenBy = this.#wakes?.during === attempt;
		if (this.#wakes !== undefined) this.#wakes.during = undefined;
		if (cause.kind === "transient") this.host.backoff.failed(this.identity);
		else this.host.backoff.delete(this.identity);
		const failure: Failed = { kind: "failed", cause, retryAt: this.host.backoff.until(this.identity) };
		this.#state = { kind: "failed", failure };
		this.#lastFailure = cause.error;
		attempt.seal(this.ended());
		const closing = attempt.close(END).then((failures) => {
			attempt.detach();
			// Released once its natives closed (a close may use them, §6, §13).
			attempt.releaseReferences();
			return failures;
		});
		this.host.ending(this.identity, this.#reported(closing));
		this.host.report({ kind: "activation_failed", object: this.label, failure: cause });
		this.#notify();
		this.#settleFirstOutcome();
		// Job runs kept it while it activated; failed, they keep it no longer.
		this.#idle();
		// A wake signal arrived while it activated: it retries it now.
		if (wokenBy) this.retry();
	}

	/**
	 * A wake signal's new value (inside its batch): retries a failed object (after the batch: a factory may not run in
	 * one), remembered while it activates, ignored while live and when its own contributions' leaving made it.
	 */
	#wake(): void {
		const state = this.#state;
		// Called by its wakes only.
		const wakes = this.#wakes!;
		if (state.kind === "activating") {
			// While parked its dependencies decide (dependency model §3.8).
			if (!state.attempt.isParked) wakes.during = state.attempt;
			return;
		}
		if (state.kind !== "failed" || wakes.leaving) return;
		queueMicrotask(() => this.retry());
	}

	/**
	 * The live attempt `attempt` leaves the registries' tables (it fails or ends), inside a batch; a composition this
	 * leaving makes wakes no wake signal of this object.
	 */
	#withdraw(attempt: Attempt): void {
		const { contributions } = attempt;
		if (contributions.length === 0) return;
		const { batch } = this.host;
		const wakes = this.#wakes;
		batch.within(() => {
			if (wakes !== undefined) {
				wakes.leaving = true;
				batch.flushing(() => {
					wakes.leaving = false;
				});
			}
			for (const contribution of contributions) contribution.record.remove(contribution);
		}, this.#context);
	}

	/**
	 * `attempt`, the instance shown, stopped changing (a live failure's admitted commits published, a restart's drain, a
	 * swapped or parked old instance retiring): its references take their last values from it, holds leave it, and the
	 * object lets it go (a reference made later never attached to it: it takes nothing from it).
	 */
	#stopFollowing(attempt: Attempt): void {
		if (this.#exposed !== attempt || !this.#following) return;
		this.#following = false;
		this.#notify();
		// Its references took their values (`#notify` retargets them at once): a failed object keeps no ended instance.
		this.#exposed = undefined;
	}

	/** Tells every holder that the state changed: references first follow what it shows now (`followed`). */
	#notify(): void {
		const holders = [...this.#holders];
		// In one batch when some reference's members move (one frame each, a diamond over several sees one change); no
		// commit at all for references that used none (activation churn).
		const retarget = (): void => {
			for (const holder of holders) holder.retarget();
		};
		if (holders.some((holder) => holder.following)) this.host.batch.within(retarget, this.#context);
		else retarget();
		for (const holder of holders) holder.moved();
	}

	/**
	 * Marks the object ended: forgotten by the host, waits rejected, references to it ended with `error` (and gone from
	 * its type's presence), its job runs ended (signals fired, waiters rejected), its transactions refused, its attempt
	 * sealed. Returns what is left to tear down; it releases nothing itself.
	 */
	#seal(ending: Ending): Teardown {
		const { error } = ending;
		const state = this.#state;
		if (state.kind === "ended") return { kind: "none" };
		const endings = this.host.endingOf(this.identity);
		// Its ending rejects the callers of its swapped-out attempts' calls too, at once.
		if (this.#retiring !== undefined) for (const old of this.#retiring.keys()) old.seal(error);
		const retiring = this.#retiringNow();
		// Its swapped-out attempts end before its teardown completes (they share its documents).
		const previous = retiring === undefined ? endings : Promise.all([endings, retiring]).then(() => {});
		this.#state = { kind: "ended", ended: { kind: "ended", error } };
		for (const records of this.#jobs.values()) records.end(error);
		if (this.#flush !== undefined) clearTimeout(this.#flush.timer);
		this.#flush = undefined;
		this.documents.seal();
		this.#stopLingering();
		this.#wakes?.stop();
		this.host.forget(this);
		// An object of the start barrier's cohort that ends before its first outcome settles it as ended.
		this.#settleFirstOutcome();
		// Sealed: its instance stops changing; its references take their last values from it.
		this.#following = false;
		const holders = [...this.#holders];
		this.#holders.clear();
		this.host.unreferenced(this, holders, this.#context);
		// Its type removed: its references wait with their last values, which they take from the instance shown (still
		// here); otherwise they end with it.
		const removal: Removal | undefined =
			ending.kind === "removed"
				? { cause: ending.cause, host: this.host, params: this.checkedParams, context: this.#context }
				: undefined;
		for (const holder of holders) {
			if (removal === undefined) holder.end(error);
			else holder.removed(removal);
		}
		this.#exposed = undefined;
		if (state.kind === "activating" && state.swap !== undefined) {
			if (!state.swap.parked) this.#withdraw(state.swap.old);
			state.swap.old.seal(error);
			state.swap.done.resolve();
		}
		// A failed attempt is closed (or closing) since it failed.
		if (state.kind === "waiting" || state.kind === "failed") return { kind: "end", previous };
		if (state.kind === "live") this.#withdraw(state.attempt);
		state.attempt.seal(error);
		return { kind: "close", attempt: state.attempt, previous };
	}

	/**
	 * The last holder of `version` left: the shown instance's shared mapping for it goes (Opus F2), so a long-lived
	 * object keeps no mapped value nobody reads.
	 */
	#dropUnheld(version: number): void {
		if (this.#heldAt(version)) return;
		this.#exposed?.dropVersion(version);
	}

	/**
	 * A remote object or a local one with params ends once it has no references and no running or finishing job runs:
	 * a live one once its type's `linger` passed without a new reference, any other at once.
	 */
	#idle(): void {
		const kind = this.#state.kind;
		// A run waiting for a live attempt keeps its object only while one is live or activating.
		const running = this.#runs > 0 && (kind === "live" || kind === "activating");
		const kept = this.#holders.size > 0 || running || (this.served.kind === "local" && this.served.hostLifetime);
		if (kept || this.#state.kind === "ended" || this.#lingering !== undefined) return;
		if (this.#state.kind !== "live" || this.served.linger === 0) {
			this.end();
			return;
		}
		// A new holder clears the timer (`hold`), so an expiry finds none.
		this.#lingering = setTimeout(() => {
			this.#stopLingering();
			this.end();
		}, this.served.linger);
		this.host.count("lingering", 1);
	}

	/** Its linger timer stops (a new holder, its expiry, its end): no longer counted as lingering. */
	#stopLingering(): void {
		if (this.#lingering === undefined) return;
		clearTimeout(this.#lingering);
		this.#lingering = undefined;
		this.host.count("lingering", -1);
	}

	/**
	 * Once the previous teardowns finished (a failed attempt's closes may read the documents): drains and closes a
	 * sealed attempt, then releases its references (after the closes, which may use them), then waits for an admitted
	 * commit step to adopt and drops the documents and job runs. Resolves with the closes that threw.
	 */
	async #tearDown(teardown: Teardown, reason: NativeCloseReason): Promise<CloseFailed[]> {
		if (teardown.kind === "none") return [];
		await teardown.previous;
		const failures = teardown.kind === "close" ? await teardown.attempt.close(reason) : [];
		if (teardown.kind === "close") {
			teardown.attempt.detach();
			teardown.attempt.releaseReferences();
		}
		await this.documents.settled();
		this.documents.end();
		this.host.store?.claims.release(this);
		for (const records of this.#jobs.values()) records.drop();
		this.#jobs.clear();
		return failures;
	}

	/** Reports the close failures of a teardown nobody waits for. */
	async #reported(closing: Promise<CloseFailed[]>): Promise<void> {
		for (const failure of await closing) this.host.report(failure);
	}

	/**
	 * The live attempt; `not_ready` before the object went live and while it activates again, the cause while failed,
	 * `released` once it ended.
	 */
	#live(): Attempt {
		const state = this.#state;
		if (state.kind === "live") return state.attempt;
		if (state.kind === "ended") throw this.ended();
		if (state.kind === "failed") throw state.failure.cause.error;
		throw new ChordError({ code: "not_ready", message: `${this.label}: not live yet` });
	}

	/** The settlement of its first outcome (once): dependents parked on it check their first pass again. */
	#settleFirstOutcome(): void {
		if (this.#hasFirstOutcome) return;
		this.#hasFirstOutcome = true;
		this.#firstOutcome?.resolve();
		this.#firstOutcome = undefined;
		for (const holder of this.#holders) holder.dependent?.dependencyMoved();
	}

	/** The chain of waits from this activation to `target` (see `Target`), through its parked attempt's dependencies. */
	pathTo(target: ChordObject, visited: Set<Target>): ChordObject[] | undefined {
		if (this === target) return [this];
		visited.add(this);
		for (const dependency of this.#waitingFor) {
			const next = dependency.kind === "reference" ? dependency.binding.target : undefined;
			if (next === undefined || visited.has(next)) continue;
			const rest = next.pathTo(target, visited);
			if (rest !== undefined) return [this, ...rest];
		}
		return undefined;
	}
}

/** Whether two states of a reference say the same: the same object, or failures with the same cause (by value). */
function sameState(a: RefState, b: RefState): boolean {
	if (a === b) return true;
	return a.kind === "failed" && b.kind === "failed" && a.retryAt === b.retryAt && sameCause(a.cause, b.cause);
}
