// Objects (§6): one per identity, from its first attempt to its end. Its state across attempts (its documents, line
// and job runs, its member sources, slice 6a §1.2), its holders, retries after failures (backoff, `ref.retry()`, passed
// on while parked), what it shows while its attempt is parked on dependencies (dependency model §3), its first outcome
// (the start barrier, decision (a)), a live object's failure (slice 6a §1.4), the waits and cycle checks of activations
// (Q5, its instance id and the activation chain it was created for), lingering after its last reference (§3, D8), the
// job runs that keep it alive (§15), its contributions to registries while live and its wake signals (`retryOn`, slice
// 8), and its ending, revocation included (§4, R11).

import type { Context } from "../../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { ContractShape } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { invalid, type Provider, sameCause } from "../data/internal.ts";
import { Documents, type KeyedSlot } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import { JobRecords } from "../jobs/internal.ts";
import { CHAIN } from "../link/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import { Attempt, type Self } from "./attempt.ts";
import type { Caller } from "./ctx.ts";
import type { Dependency } from "./dependencies.ts";
import type { AnyHost } from "./host.ts";
import { KeyedMembers, type PinnedKey } from "./keyed-members.ts";
import { MemberSource } from "./member-source.ts";
import type { KeyedBinding } from "./members.ts";
import type { CloseFailed, NativeCloseReason } from "./native.ts";
import { type Ended, type Failed, LIVE, LOADING, type RefState } from "./ref-state.ts";
import { type RetryOperation, retryOperation, type Target } from "./reference.ts";
import { type RetrySource, RetryWakes } from "./retry-on.ts";
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
	/** The object's state (`state`) changed: an attempt started after a failure, it went live, or it failed. */
	moved(): void;
	/** The object ended with `error`. */
	end(error: ChordError): void;
}

/**
 * Where an object stands. `waiting`: for its identity's backoff window before its first attempt. `activating` has what
 * its references show: `loading`, or `failed { waiting }` while its attempt is parked on a failed dependency. `failed`
 * has the state its references show.
 */
type ObjectState =
	| { readonly kind: "waiting" }
	| { readonly kind: "activating"; readonly attempt: Attempt; readonly shown: RefState }
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

const END: NativeCloseReason = { kind: "end" };

const CLOSE: NativeCloseReason = { kind: "close" };

/** How many retry ids an object remembers: a diamond's shortcut only (a ring is stopped by a retry's `through`). */
const RETRIES_KEPT = 8;

/** No dependencies waited for: the shared empty list. */
const NO_DEPENDENCIES: readonly Dependency[] = [];

/**
 * One object. Each attempt is a fresh `Attempt`; the documents, the line, the job runs and the holders outlive it. An
 * attempt parked on its dependencies waits for them without a timer; a transient failure (its own) is retried after its
 * backoff window, or at once when a reference asks (`retry`); a broken one stays failed until a reference asks.
 * The object ends with its last reference, a live one after its type's `linger` (never, for a host-lifetime object),
 * or when the host closes.
 */
export class ChordObject implements Target {
	readonly host: AnyHost;
	readonly served: Served;
	readonly params: ParamsOf<Contract>;
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
	/**
	 * The ids of the last retry operations it handled (at most `RETRIES_KEPT`, the newest last; made by the first): a
	 * retry reaching it twice through a diamond is handled once.
	 */
	#retried: string[] | undefined;
	/** The error of the last failed attempt, or the last cause a parked attempt showed, until one goes live. */
	#lastFailure: ChordError | undefined;
	/** Ends the object when its type's `linger` passed after its last reference; cleared by a new one. */
	#lingering: ReturnType<typeof setTimeout> | undefined;
	/** Its running and finishing job runs: they keep it alive like references (D4), without being references. */
	#runs = 0;
	/**
	 * The attempt its member sources show: the live one, or the last one that went live while the object is failed or
	 * activating again (their last values); `undefined` before the first went live.
	 */
	#exposed: Attempt | undefined;
	/** Its state members as references and other objects' derives follow them, by name; each made by its first use. */
	readonly #members = new Map<string, MemberSource>();
	/** The keys of its keyed members that references hold, across attempts. */
	readonly #keys: KeyedMembers;
	/** The one timer storing its jobs' held state changes by their earliest deadline (D8), while one is held. */
	#flush: { readonly deadline: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	/** Its wake signals (`retryOn`), the last attempt's declaration; made by the first. */
	#wakes: RetryWakes | undefined;

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
		this.identity = identity;
		this.label = key === "" ? served.contract.name : `${served.contract.name}(${key})`;
		this.chain = chain;
		this.#context = context;
		this.#keys = new KeyedMembers(host.batch, context);
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

	/** Whether its state members have values while it is not live: once an attempt went live, until it ends. */
	get lastValues(): boolean {
		return this.#exposed !== undefined && this.#state.kind !== "ended";
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

	/** An object here: it is not held on a link. */
	get heldOnLink(): false {
		return false;
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
	 * Starts an attempt when waiting or failed; a trigger while an attempt runs (or once live) is ignored. After a
	 * failure the holders are told: their references are loading again.
	 */
	attempt(): void {
		const state = this.#state;
		if (state.kind !== "waiting" && state.kind !== "failed") return;
		this.#instance ??= uuidv7();
		const attempt = new Attempt(this, this.#context);
		this.#state = { kind: "activating", attempt, shown: LOADING };
		if (state.kind === "failed") this.#notify();
		void this.#run(attempt);
	}

	/**
	 * `ref.retry()` and a `retry` message, as `operation` (handled once): an attempt now when failed (a broken one too)
	 * or waiting, its backoff window skipped; passed on to the failed dependencies while parked `failed { waiting }`,
	 * with this object added to the objects it passed through (at most `CHAIN`: a retry stops past 32 hops); ignored
	 * otherwise (an attempt runs, or it is live), and when it passed through this object already (a ring) or was handled
	 * here already (a diamond).
	 */
	retry(operation: RetryOperation = retryOperation()): void {
		const instance = this.#instance;
		if (instance !== undefined && operation.through.includes(instance)) return;
		if (this.#handled(operation.id)) return;
		const state = this.#state;
		if (state.kind === "activating") {
			const { through } = operation;
			if (state.shown.kind !== "failed" || instance === undefined || through.length >= CHAIN) return;
			state.attempt.retryDependencies({ id: operation.id, through: [...through, instance] });
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

	/** Calls a method of the live object for `caller`. */
	async call(method: string, args: unknown, context: Context, caller: Caller): Promise<unknown> {
		return this.#live().call(method, args, context, caller);
	}

	/**
	 * The state member `member` as references and other objects' derives follow it across attempts: its member source,
	 * with its last value while the object is not live (`lastValues`).
	 */
	member(member: string): DeriveSource {
		// Made once per member and dropped at the end: a source found here is the one to follow.
		const made = this.#members.get(member);
		if (made !== undefined) return made;
		const exposed = this.#exposed;
		if (exposed === undefined || this.#state.kind === "ended") return this.#live().member(member);
		return this.#memberSource(member, exposed);
	}

	/** The keyed member `member` of the live object: its ultimate slot (slice 6a §12). */
	keyedMember(member: string): KeyedSlot {
		return this.#live().keyedMember(member);
	}

	/** Pins `key` of the live object's keyed member `member` across its attempts (`KeyedMembers.pin`). */
	async pinKey(member: string, key: string, context: Context): Promise<PinnedKey> {
		const attempt = this.#live();
		const stored = attempt.keyedMember(member).key(key);
		return this.#keys.pin(member, stored, attempt.keyedMembers.get(member)!, context);
	}

	/**
	 * An activating attempt's keyed members are checked: the keys references pin are loaded on them before it goes
	 * live; `undefined` when none is held.
	 */
	prepareKeys(members: ReadonlyMap<string, KeyedBinding>, context: Context): Promise<void> | undefined {
		return this.#keys.prepare(members, context);
	}

	/**
	 * Counts `holder` as a reference to this object (the holder reads `state` itself), listed in its type's presence; a
	 * lingering object stays.
	 */
	hold(holder: Holder): void {
		this.#holders.add(holder);
		this.#stopLingering();
		// Last: a derive over the presence list may close a link synchronously, which may release this holder again.
		this.host.referenced(this, holder, this.#context);
	}

	/** `holder` was released: the object may end (`#idle`). */
	unhold(holder: Holder): void {
		if (!this.#holders.delete(holder)) return;
		this.#idle();
		// Last: a derive over the presence list may close a link synchronously, which releases other holders again.
		this.host.unreferenced(this, [holder], this.#context);
	}

	/**
	 * The records of job `definition`'s runs, made by its first declaration. A later declaration of another version is
	 * refused (versions of runs across attempts are slice 7's).
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
		if (records.definition.version !== definition.version) {
			throw new Error(
				`${this.label}: job "${definition.name}" is declared at version ${definition.version}, its runs are at ${records.definition.version}`,
			);
		}
		return records;
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
	 * object `failed` with `cause`; calls reject with it, holders are told, the state members keep their values once the
	 * admitted commits adopted, the natives close in the background (then its references are released), `onError` gets
	 * `object_failed` once. Documents and job runs stay. Recovery: a broken failure by `ref.retry()`, a transient one
	 * after its identity's backoff too (a new attempt, whose members the member sources follow once it is live). A
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
		// Members following another object's sources freeze now: no commit of this object changes them.
		this.#freeze(attempt, "foreign");
		// The commits admitted before the seal adopt and publish once (frames included); then the other members keep
		// their values. A retry's factory and hydration wait for both (its ending), so no old commit lands in a new
		// attempt.
		const frozen = this.documents.settled().then(() => this.#freeze(attempt, "all"));
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
		if (!sameState(state.shown, shown)) {
			this.#state = { kind: "activating", attempt, shown };
			if (shown.kind === "failed") this.#lastFailure = shown.cause.error;
			this.#notify();
		}
		if (firstPass) this.#settleFirstOutcome();
	}

	/** Its attempt `attempt` left parking for its own steps: it shows `loading` until its outcome. */
	unparked(attempt: Attempt): void {
		this.parked(attempt, LOADING, false);
	}

	/**
	 * Ends the object (once): sealed now, its holders and running calls told `error` (`released` by default), torn down
	 * in the background with reason `end`, close failures reported.
	 */
	end(error: ChordError = this.ended()): void {
		const teardown = this.#seal(error);
		if (teardown.kind !== "none") this.host.ending(this.identity, this.#reported(this.#tearDown(teardown, END)));
	}

	/**
	 * Ends the object for `host.close`: sealed now; returns its teardown (reason `close`), which the host runs once every
	 * object is sealed, so no reference it releases starts an ending in the background.
	 */
	stop(): () => Promise<CloseFailed[]> {
		const teardown = this.#seal(this.ended());
		return () => this.#tearDown(teardown, CLOSE);
	}

	/** The `released` error of this object. */
	ended(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: ended` });
	}

	async #run(attempt: Attempt): Promise<void> {
		const outcome = await attempt.activate(this.host.endingOf(this.identity));
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
		this.#state = { kind: "live", attempt };
		this.#exposed = attempt;
		if (this.#members.size > 0 || !this.#keys.empty)
			this.host.batch.within(() => this.#rebind(attempt), this.#context);
		const { contributions } = attempt;
		// In the registries' tables before anyone sees it live (a getter released now reads them recomposed).
		if (contributions.length > 0) {
			this.host.batch.within(() => {
				for (const contribution of contributions) contribution.record.add(contribution);
			}, this.#context);
		}
		this.#lastFailure = undefined;
		this.host.wentLive(this);
		this.#notify();
		this.#settleFirstOutcome();
		attempt.live();
	}

	/**
	 * Records a failed attempt: reported, torn down in the background (reason `end`), its references released once its
	 * natives closed, its holders told. Transient: a backoff window, whose end is the failure's `retryAt`; broken: no
	 * automatic retry.
	 */
	#failed(attempt: Attempt, cause: FailureCause): void {
		const wokenBy = this.#wakes?.during === attempt;
		if (this.#wakes !== undefined) this.#wakes.during = undefined;
		// What its activation loaded for the pinned keys goes; they stay frozen.
		this.#keys.discard();
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

	/** The member source of `member`, made bound to `exposed`'s member by its first use. */
	#memberSource(member: string, exposed: Attempt): MemberSource {
		let source = this.#members.get(member);
		if (source === undefined) {
			source = new MemberSource(exposed.member(member), this.host.batch);
			this.#members.set(member, source);
		}
		return source;
	}

	/**
	 * The attempt `attempt` failed live: its state members and pinned keys keep their values from now on (each made now
	 * when nothing used it yet, so reads while failed find it). `foreign`: those following another object's sources
	 * (at once); `all`: every one (once the admitted commits adopted).
	 */
	#freeze(attempt: Attempt, which: "foreign" | "all"): void {
		if (this.#exposed !== attempt || this.#state.kind === "ended") return;
		for (const [member, source] of attempt.stateMembers) {
			if (which === "all" || !attempt.owns(source)) this.#memberSource(member, attempt).freeze();
		}
		// A pin still loading is given up with the failure: a consumer parked on it shows `failed { waiting }`.
		this.#keys.freeze(which, this.#lastFailure ?? this.ended());
	}

	/**
	 * A new attempt went live, inside a batch: every member source follows its member of the same name, every pinned key
	 * its keyed member's (loaded by its activation).
	 */
	#rebind(attempt: Attempt): void {
		const members = attempt.stateMembers;
		for (const [member, source] of this.#members) {
			const found = members.get(member);
			if (found !== undefined) {
				source.bind(found);
				continue;
			}
			const variant = attempt.variant === undefined ? "" : ` (variant ${attempt.variant})`;
			source.vanish(invalid("member", `${this.label}${variant} has no state member "${member}"`), this.#context);
		}
		this.#keys.rebind();
	}

	/** Tells every holder that the state changed. */
	#notify(): void {
		for (const holder of [...this.#holders]) holder.moved();
	}

	/**
	 * Marks the object ended: forgotten by the host, waits rejected, references to it ended with `error` (and gone from
	 * its type's presence), its job runs ended (signals fired, waiters rejected), its transactions refused, its attempt
	 * sealed. Returns what is left to tear down; it releases nothing itself.
	 */
	#seal(error: ChordError): Teardown {
		const state = this.#state;
		if (state.kind === "ended") return { kind: "none" };
		const previous = this.host.endingOf(this.identity);
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
		// In a batch: the derives over its members are marked, so none keeps a cached value.
		this.host.batch.within(() => {
			for (const source of this.#members.values()) source.objectEnded(error);
			this.#keys.end(error);
		}, this.#context);
		this.#members.clear();
		this.#exposed = undefined;
		const holders = [...this.#holders];
		this.#holders.clear();
		this.host.unreferenced(this, holders, this.#context);
		for (const holder of holders) holder.end(error);
		// A failed attempt is closed (or closing) since it failed.
		if (state.kind === "waiting" || state.kind === "failed") return { kind: "end", previous };
		if (state.kind === "live") this.#withdraw(state.attempt);
		state.attempt.seal(error);
		return { kind: "close", attempt: state.attempt, previous };
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

	/**
	 * Whether the retry operation `id` reached it before (among the last few: the diamond's shortcut; a ring is stopped
	 * by `through`); records it otherwise.
	 */
	#handled(id: string): boolean {
		this.#retried ??= [];
		const retried = this.#retried;
		if (retried.includes(id)) return true;
		if (retried.length === RETRIES_KEPT) retried.shift();
		retried.push(id);
		return false;
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
