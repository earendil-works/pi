// Admission (slice 14 §2): the decision made about a caller before anything is built or started. A remote type's
// provider declares it with `admit`, run first in every attempt: it reads data about the caller (references with keyed
// pins, registries, derives, live queries) and returns a watchable of `allow(value)` or `deny(reason)`; the factory is
// handed the value, whose `granted` names the grantable members and flags the caller gets (slice 15 §1.2). A route asks
// the same way before it resolves or forwards a hold. This file has the app's types and one `Decision`: what one
// `admit` declared, what it says now, and the watch its owner follows it with. What follows from a decision is its
// owner's: an attempt parks, goes on or is sealed (`attempt.ts`, `object.ts`), a route holds back, forwards or releases
// (`route-admission.ts`).

import type { Context } from "../context/index.ts";
import type { AllowedOf, Contract, NamedQuery, ParamsOf } from "../contracts/index.ts";
import { NO_GRANTS } from "../contracts/internal.ts";
import { ChordError, forbidden, type MessageData, type Principal } from "../data/index.ts";
import { asChordError, checkParams, isMessageData, sameJson, stackless, walkJson } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import { appended, NO_ITEMS } from "../lists.ts";
import type { Registry, RegistryValue } from "../registries/index.ts";
import type { RegistryWaiter } from "../registries/internal.ts";
import { type Dependent, Derive, type DeriveSource, Source } from "../state/internal.ts";
import { chordMetrics } from "../telemetry.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";
import type { Self } from "./attempt.ts";
import type { Caller } from "./ctx.ts";
import {
	type Blocked,
	type Check,
	checkDependencies,
	type Dependency,
	type Parking,
	parkedCause,
	pinKeys,
	waitingOn,
} from "./dependencies.ts";
import type { AnyHost } from "./host.ts";
import { attachDerives } from "./members.ts";
import type { ChordObject, Served } from "./object.ts";
import type { Reader } from "./query-reader.ts";
import { openReaders, readerSite, rowsReader } from "./read-declarations.ts";
import { type Binding, type CheckedParams, type Reference, resolveWatchable } from "./reference.ts";

/**
 * An admission's decision: the value the factory is handed about the caller, or a denial with its reason (English, for
 * logs) and the message the person sees (as data, slice 15 §2).
 */
export type Admission<T> =
	| { readonly kind: "allow"; readonly value: T }
	| { readonly kind: "deny"; readonly reason: string; readonly message?: MessageData };

/**
 * What `admit` declares with, valid only while it runs: references (`at(key)` on their keyed members), registries,
 * derives and live queries. An admission decides and owns nothing: no documents, natives, routines or jobs.
 */
export type AdmitSelf = Pick<Self, "get" | "registry" | "derive" | "liveQuery">;

/**
 * A remote type's admission (`host.serve(Type, factory, { admit })`): synchronous and declarative, run first in every
 * attempt. Its attempt parks until what it declared is live and hydrated, then reads the decision and follows it: an
 * equal value changes nothing, another one rebuilds the object, a denial shows `failed { denied }`.
 */
export type Admit<C extends Contract, P extends Principal = Principal> = (
	params: ParamsOf<C>,
	principal: P,
	self: AdmitSelf,
) => Watchable<Admission<AllowedOf<C>>>;

/**
 * An allow as a decision keeps it: the same object for as long as the value stays equal (as canonical JSON, `granted`
 * as a set of names). `value` is what the factory is handed (`granted` as a set), `granted` the names.
 */
export type Allowed = {
	readonly kind: "allow";
	readonly value: JsonValue | AdmittedValue;
	readonly granted: ReadonlySet<string>;
};

/** An object's admitted value as its factory gets it: the admitted data, and `granted` as a set. */
export type AdmittedValue = { readonly [field: string]: unknown; readonly granted: ReadonlySet<string> };

/** A denial as a decision keeps it: the same object, and the same error, for as long as the reason stays. */
export type Denied = { readonly kind: "deny"; readonly error: ChordError };

/**
 * What a decision says at one check: allowed with a value, denied, not decided (parked on what it reads: `loading`, or
 * `failed { waiting }` on a source that failed or a decision that cannot be read), or broken (a cycle, an ended
 * source, a value that is no decision).
 */
export type Verdict = Allowed | Denied | Exclude<Parking, { readonly kind: "ready" }>;

/** Who a decision is made for and what it tells. */
export type DecisionOwner = {
	readonly host: AnyHost;
	/** What it decides about, in errors and reports: an object's label, or a route's address. */
	readonly label: string;
	/** Whom its references act as: a remote object's principal, the host for a route. */
	readonly caller: Caller;
	/** The object whose attempt it admits (its references' dependent: cycles, the start barrier); none for a route. */
	readonly dependent: ChordObject | undefined;
	/**
	 * An object's: the names its contract lets an admission grant (grantable members and flags, slice 15 §1.2), against
	 * which an allowed value is read; none for a route, whose value is passed on as it is.
	 */
	readonly grants: readonly string[] | undefined;
	/** Something it reads changed (a source's state, the decision's value, in that change's batch): check it again. */
	moved(): void;
};

/**
 * Allows the caller: `value` is what the factory is handed about it, plain JSON: the names in `granted` (the grantable
 * members and flags the caller gets, slice 15 §1.2) and the data the contract's `admission` schema describes (never
 * validated). Small and rarely changing (a role): another value rebuilds the caller's object.
 */
export function allow<const T extends JsonValue>(value: T): Admission<T> {
	return { kind: "allow", value };
}

/**
 * Denies the caller. `reason` is English, for logs: the message of its `forbidden` error. `message` is what the person
 * sees, as data their client renders in their language (slice 15 §2): it travels in the error's `details.message`.
 */
export function deny(reason: string, message?: MessageData): Admission<never> {
	return message === undefined ? { kind: "deny", reason } : { kind: "deny", reason, message };
}

/** A reference a decision declared, bound when `admit` returned. */
type Declared = { readonly binding: Binding; readonly contract: Contract; readonly params: CheckedParams };

/** No state members: a decision's derives are exposed by none. */
const NO_MEMBERS: ReadonlyMap<string, DeriveSource> = new Map();

/** A decision without live queries follows none: the shared wake, never told. */
const NO_WAKE: Dependent = { invalidate: () => {}, sourceRetired: () => {} };

/**
 * One decision: the `self` its `admit` declares with, the requests it made (held until `release`), and what it says.
 * `settle` brings it to a verdict (its pinned keys loaded, its live queries opened); `now` reads it again, in the
 * flush of the batch that changed it. A source that only loads keeps the last decision; one that failed or ended, and
 * a decision that throws when read, do not (fail closed: slice 14 §2.2).
 */
export class Decision implements AdmitSelf, Dependent, RegistryWaiter {
	readonly #owner: DecisionOwner;
	/** The context `admit` declares under, while it runs (its params are checked with it). */
	#declaring: Context | undefined;
	#references: readonly Declared[] = NO_ITEMS;
	#dependencies: readonly Dependency[] = NO_ITEMS;
	#derives: readonly Derive[] = NO_ITEMS;
	#readers: readonly Reader[] = NO_ITEMS;
	/** Ends its follows of its references' states (`#unfollow`). */
	#unfollows: readonly (() => void)[] = NO_ITEMS;
	/** The signal whose abort ends those follows, while it listens to it (`#followUntilAborted`). */
	#ending: AbortSignal | undefined;
	/** Ends its reads of its registries: `release`. */
	#releases: readonly (() => void)[] = NO_ITEMS;
	/** The watchable `admit` returned, as Chord follows it. */
	#source: DeriveSource | undefined;
	/** The last allow or denial it read, with what it was read from: an equal one is the same object. */
	#decided: Decided | undefined;
	/** Whether a change of its source waits for the current batch's flush: one check per batch. */
	#flushing = false;
	/** Follows a live query it waits on: its next adoption checks again. Made by the first settle with live queries. */
	#readerWake: Dependent | undefined;
	#released = false;

	constructor(owner: DecisionOwner) {
		this.#owner = owner;
	}

	/** Its requests in declaration order: what its owner parks on; none once released. */
	get dependencies(): readonly Dependency[] {
		return this.#dependencies;
	}

	get<C extends Contract>(Type: C, params: ParamsOf<C>): Reference<C> {
		const { host, dependent, caller } = this.#owner;
		const checked = checkParams(Type, params, this.#assertDeclaring("get"));
		const binding = host.reference(Type, dependent, caller, {});
		this.#references = appended(this.#references, { binding, contract: Type, params: checked });
		this.#dependencies = appended(this.#dependencies, { kind: "reference", binding });
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	registry<C, V>(R: Registry<C, V>): RegistryValue<V> {
		this.#assertDeclaring("registry");
		const value = this.#owner.host.registryRecord(R.name).value(R.version);
		this.#dependencies = appended(this.#dependencies, { kind: "registry", value });
		// Its values are the composition as `R`'s version has it, `V`.
		return value as RegistryValue<V>;
	}

	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (
			values: {
				readonly [I in keyof S]: S[I] extends Watchable<infer V>
					? V
					: S[I] extends NativeWatchable<infer V>
						? V
						: never;
			},
		) => T,
	): Watchable<T> {
		this.#assertDeclaring("derive");
		// The values are the sources' values, in order; the result is `T`.
		const derive = new Derive(sources, compute as (values: readonly unknown[]) => T, this.#owner.host.batch);
		this.#derives = appended(this.#derives, derive);
		return derive as unknown as Watchable<T>;
	}

	liveQuery<T, A>(
		query: NamedQuery<T, A>,
		args: A | Watchable<A>,
		range: { readonly first: number },
	): Watchable<{ rows: T[]; more: boolean }> {
		this.#assertDeclaring("liveQuery");
		const { host, label } = this.#owner;
		const at = readerSite(host, label, () => this.#owner.moved());
		const { reader, source } = rowsReader(at, query, args, range);
		this.#readers = appended(this.#readers, reader);
		// Its value is what `present` builds from the query's items.
		return source as unknown as Watchable<{ rows: T[]; more: boolean }>;
	}

	/**
	 * Runs `admit` with declarations open, then binds what it declared under `context` and follows it: its references
	 * (bound in declaration order, cycles checked for an attempt's), its registries, its derives, and the watchable it
	 * returned. Throws what `admit` throws, a refused request's error, and for a result that is no Chord watchable; its
	 * caller then releases it.
	 */
	declare(admit: (self: AdmitSelf) => unknown, context: Context): void {
		const { host, dependent, label } = this.#owner;
		this.#declaring = context;
		let returned: unknown;
		try {
			returned = admit(this);
		} finally {
			this.#declaring = undefined;
		}
		const source = resolveWatchable(returned);
		if (source === undefined) {
			throw new Error(`${label}: admit returns a JSON watchable of allow(value) or deny(reason)`);
		}
		this.#source = source;
		for (const { binding, contract, params } of this.#references) host.bind(binding, contract, params, context);
		// Once all are bound: a dependency made here may have bound back to the admitted object meanwhile.
		for (const { binding } of this.#references) {
			const { target } = binding;
			if (target !== undefined) dependent?.assertNoCycle(target, context);
		}
		// Told now and at every change of a reference, until the release or `context`'s abort: its owner checks it again.
		const moved = (): void => this.#owner.moved();
		const signal = context.abortSignal;
		if (signal !== undefined && this.#references.length > 0) this.#followUntilAborted(signal);
		for (const dependency of this.dependencies) {
			if (dependency.kind === "registry") {
				// Read until its release: an older version's mapping is kept meanwhile.
				this.#releases = appended(appended(this.#releases, dependency.value.read()), dependency.value.wait(this));
				continue;
			}
			// Aborted already (by what an earlier reference's first telling did, too): this one is not followed.
			if (signal?.aborted) continue;
			const unfollow = dependency.binding.followState(moved);
			if (unfollow === undefined) continue;
			this.#unfollows = appended(this.#unfollows, unfollow);
			// Told now too, its end kept first: this telling may abort the context, which ends this follow as well.
			moved();
		}
		attachDerives(this.#derives, NO_MEMBERS, () => (error) => {
			host.report({ kind: "derive_failed", object: label, error });
		});
		if (source instanceof Source) source.dependents.add(this);
	}

	/**
	 * Brings it to a verdict: once every request is live, the keys it pinned are loaded and its live queries opened
	 * (each named to `long` while it blocks), then the decision is read. Nothing blocks `long` for an allow or a
	 * denial: `parked_long` reports no denial.
	 */
	async settle(long: Blocked, context: Context): Promise<Verdict> {
		const check = checkDependencies(this.dependencies);
		if (check.kind !== "live") {
			const verdict = this.#unsettled(check);
			long.blockedBy(verdict.kind === "parked" && check.kind === "parked" ? check.blocker : undefined);
			return verdict;
		}
		const bindings = this.#references.map(({ binding }) => binding);
		const pinned = await pinKeys(bindings, long, context);
		if (pinned !== undefined) return { kind: "parked", shown: pinned, firstPass: true, cause: pinned.cause };
		const label = `${this.#owner.label}: a live query of its admission`;
		// Without live queries nothing is followed: no wake is made.
		if (this.#readers.length > 0) {
			this.#readerWake ??= { invalidate: () => this.#owner.moved(), sourceRetired: () => {} };
		}
		const reading = await openReaders(this.#readers, this.#readerWake ?? NO_WAKE, long, label, context);
		if (reading.kind !== "ready") {
			// A live query whose read has not run yet keeps the last decision, as a source that only loads does.
			const loading = reading.kind === "parked" && reading.shown.kind === "loading";
			return loading && this.#decided !== undefined ? this.#decided.verdict : reading;
		}
		const verdict = this.#read(context);
		long.blockedBy(undefined);
		return verdict;
	}

	/**
	 * What it says now, after it settled once (its keys loaded, its live queries open): read synchronously, in the flush
	 * of the batch that changed it. The same object as before means nothing changed.
	 */
	now(context: Context): Verdict {
		const check = checkDependencies(this.dependencies);
		return check.kind === "live" ? this.#read(context) : this.#unsettled(check);
	}

	/**
	 * Lets go of everything it declared (once): its references and registry reads released, its derives and live
	 * queries detached. Its owner calls it once the decision that replaces it has bound its own requests, so a source
	 * held only by decisions never loses its last holder across a rebuild (slice 14 §2.2, rule 4).
	 */
	release(): void {
		if (this.#released) return;
		this.#released = true;
		const { label } = this.#owner;
		const ended = stackless({ code: "released", reason: "ended", message: `${label}: its admission ended` });
		this.#unfollow();
		const source = this.#source;
		if (source instanceof Source) source.dependents.delete(this);
		this.#source = undefined;
		const wake = this.#readerWake;
		for (const reader of this.#readers) {
			if (wake !== undefined) reader.source.dependents.delete(wake);
			reader.close(ended);
		}
		for (const derive of this.#derives) derive.detach(ended);
		const releases = this.#releases;
		this.#releases = NO_ITEMS;
		for (const release of releases) release();
		const references = this.#references;
		this.#references = NO_ITEMS;
		for (const { binding } of references) binding.release();
		this.#dependencies = NO_ITEMS;
	}

	/**
	 * Its follows of its references' states end where a wait under the context it declares under would: among the
	 * listeners of a signal that depends on the context's, made now. That place in an abort's dispatch decides what
	 * the decision is still told (after the listeners of the context's own signal and of the signals made from it
	 * before, ahead of those made later: an opener's, a resolver's), so the signal is the price of it (about 1.1 KiB
	 * for a decision with references; the decision itself is its listener, `handleEvent`).
	 */
	#followUntilAborted(signal: AbortSignal): void {
		if (signal.aborted) return;
		this.#ending = AbortSignal.any([signal]);
		this.#ending.addEventListener("abort", this, { once: true });
	}

	/** The context it declared under was aborted (`#followUntilAborted`): it follows its references no more. */
	handleEvent(): void {
		this.#unfollow();
	}

	/** Ends its follows of its references' states; it listens for no abort any more. */
	#unfollow(): void {
		this.#ending?.removeEventListener("abort", this);
		this.#ending = undefined;
		const unfollows = this.#unfollows;
		this.#unfollows = NO_ITEMS;
		for (const unfollow of unfollows) unfollow();
	}

	/** Its source changed in the current batch: its owner checks it in that batch's flush, once however many changed. */
	invalidate(): void {
		if (this.#flushing || this.#released) return;
		this.#flushing = true;
		this.#owner.host.batch.flushing(() => {
			this.#flushing = false;
			if (!this.#released) this.#owner.moved();
		});
	}

	/** A retired document under its source is a change of its value, which `invalidate` tells. */
	sourceRetired(): void {}

	/** A registry it reads changed whether its value is usable. */
	dependencyMoved(): void {
		this.#owner.moved();
	}

	/** A registry it reads closed with its host: the host ends its owner. */
	closed(): void {}

	/**
	 * What a check that found a request not live says: broken; parked on a failure; or, only loading, the last decision
	 * (a provider restarting or a link down changes no access), `loading` before the first.
	 */
	#unsettled(check: Exclude<Check, { readonly kind: "live" }>): Verdict {
		if (check.kind === "broken") return check;
		if (check.shown.kind === "loading" && this.#decided !== undefined) return this.#decided.verdict;
		return { kind: "parked", shown: check.shown, firstPass: check.firstPass, cause: parkedCause(check) };
	}

	/**
	 * Reads the decision. A read that throws (a derive of `admit`, a failed live query) is a failed source: parked
	 * `failed { waiting }` on it. Plugin code is bundled without type checks (declaration policy): a value that is
	 * neither `allow(value)` nor `deny(reason)` breaks.
	 */
	#read(context: Context): Verdict {
		const { label } = this.#owner;
		let decision: unknown;
		try {
			decision = this.#source?.value;
		} catch (error) {
			const shown = waitingOn(`${label}: its admission`, asChordError(error, label));
			return { kind: "parked", shown, firstPass: true, cause: shown.cause };
		}
		const decided = this.#decided;
		// The object it was read from last (a derive that did not recompute, a constant): that decision, read no more.
		if (decided !== undefined && decision === decided.decision) return decided.verdict;
		const { kind, value, reason, message } = (decision ?? {}) as {
			kind?: unknown;
			value?: JsonValue;
			reason?: unknown;
			message?: unknown;
		};
		if (kind === "allow" && value !== undefined) {
			if (decided?.kind === "allow" && this.#sameAllow(decided, value)) {
				countWalk(context);
				decided.decision = decision;
				decided.value = value;
				return decided.verdict;
			}
			return this.#allow(decision, value, context);
		}
		if (kind === "deny" && typeof reason === "string") {
			if (message !== undefined && !isMessageData(message, context)) {
				const error = new Error(`its denial's message is no message as data (MessageSchema): ${reason}`);
				return { kind: "broken", error: asChordError(error, label) };
			}
			countWalk(context);
			if (decided?.kind === "deny" && reason === decided.reason && sameMessage(decided.message, message)) {
				decided.decision = decision;
				decided.message = message;
				return decided.verdict;
			}
			// Checked just above.
			const details = message === undefined ? undefined : { message: message as MessageData };
			const verdict: Denied = { kind: "deny", error: forbidden(reason, details) };
			this.#decided = { kind: "deny", decision, reason, message, verdict };
			return verdict;
		}
		const error = new Error("its admission's value is neither allow(value) nor deny(reason)");
		return { kind: "broken", error: asChordError(error, label) };
	}

	/**
	 * Whether an allowed `value` is the last allow's, without copying, sorting or serializing anything (an equal
	 * decision made 2.8 KiB of copies and text per read before): the same object, or the same data field by field and the same names in `granted` (in any order,
	 * repeated or not). A name that is no grant says no: `#allow` breaks on it.
	 */
	#sameAllow(decided: DecidedAllow, value: JsonValue): boolean {
		if (value === decided.value) return true;
		const { grants } = this.#owner;
		// A route's value goes on as it is.
		if (grants === undefined) return sameJson(decided.value, value);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		if (!sameJson(decided.value, value, "granted")) return false;
		const listed = value.granted;
		const last = (decided.value as { readonly granted?: JsonValue }).granted;
		return listed === last || sameNames(listed, decided.verdict.granted, grants);
	}

	/** A new allow (another value than the last one's): read against its contract's grants, kept as the last one. */
	#allow(decision: unknown, value: JsonValue, context: Context): Allowed | Extract<Verdict, { kind: "broken" }> {
		const { grants, label } = this.#owner;
		let verdict: Allowed;
		// Walked as canonical JSON was made of it before (it throws on a bigint, a cycle): `sameJson` compares with it.
		if (grants === undefined) {
			countWalk(context);
			walkJson(value);
			verdict = { kind: "allow", value, granted: NO_GRANTS };
		} else {
			const read = grantedOf(value, grants, label);
			if (read.kind === "broken") return read;
			const { data, granted } = read;
			countWalk(context);
			walkJson(data);
			// A copy of its own (`grantedOf`): what the factory is handed.
			data.granted = granted;
			verdict = { kind: "allow", value: data as AdmittedValue, granted };
		}
		this.#decided = { kind: "allow", decision, value, verdict };
		return verdict;
	}

	/** The context `admit` runs under; outside it, `declaration` is refused. */
	#assertDeclaring(declaration: string): Context {
		const declaring = this.#declaring;
		if (declaring === undefined) {
			throw new Error(`${this.#owner.label}: self.${declaration} is valid only in admit`);
		}
		return declaring;
	}
}

/**
 * An object's allowed value read against the names its contract lets an admission grant (slice 15 §1.2; plugin code,
 * bundled without type checks): an object whose `granted`, when present, lists only such names. Returns a copy of its
 * data without `granted` (the caller's to complete) and the names as a set (sorted, without duplicates: an equal set
 * in another order is the same decision); anything else breaks, naming the contract and the name.
 */
function grantedOf(
	value: JsonValue,
	grants: readonly string[],
	label: string,
):
	| { readonly kind: "read"; readonly data: { [field: string]: unknown }; readonly granted: ReadonlySet<string> }
	| Extract<Verdict, { readonly kind: "broken" }> {
	const broken = (message: string) => ({ kind: "broken" as const, error: asChordError(new Error(message), label) });
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return broken("its admission's value is an object (allow({ granted, ...data }))");
	}
	const { granted: listed, ...data } = value;
	if (listed === undefined) return { kind: "read", data, granted: NO_GRANTS };
	if (!Array.isArray(listed)) return broken("its admission's granted is a list of names");
	for (const name of listed) {
		if (typeof name !== "string" || !grants.includes(name)) {
			return broken(`its admission granted ${JSON.stringify(name)}: no grantable member or flag of its contract`);
		}
	}
	// No names is no grant: `allow({})` and `allow({ granted: [] })` are one decision.
	if (listed.length === 0) return { kind: "read", data, granted: NO_GRANTS };
	// Checked just above: grantable names.
	return { kind: "read", data, granted: grantedSet(grants, listed as readonly string[]) };
}

/**
 * Whether `listed` (an allow's `granted`) names exactly the set `granted`, each name a grant: absent and empty are no
 * names; repeated names and their order do not count. Allocates nothing.
 */
function sameNames(
	listed: JsonValue | readonly string[] | undefined,
	granted: ReadonlySet<string>,
	grants: readonly string[],
): boolean {
	if (listed === undefined) return granted.size === 0;
	if (!Array.isArray(listed)) return false;
	// Indexed: a for-of allocates an iterator per list.
	for (let index = 0; index < listed.length; index++) {
		const name = listed[index];
		if (typeof name !== "string" || !grants.includes(name) || !granted.has(name)) return false;
	}
	// Each name listed is in the set: the set has no other when it has as many as there are distinct names listed.
	let distinct = 0;
	for (let index = 0; index < listed.length; index++) {
		if (listed.indexOf(listed[index]) === index) distinct++;
	}
	return distinct === granted.size;
}

/** Whether a denial's message is the last one's: both none, or the same message as data. */
function sameMessage(last: unknown, message: unknown): boolean {
	return last === undefined || message === undefined ? last === message : sameJson(last, message);
}

/** One walk of a decision's value: read against the last one, or kept as the new one. */
function countWalk(context: Context): void {
	chordMetrics(context.telemetry.metrics).counter("chord.data.walks").add(1);
}

/** The last allow a decision read, with the object and value it was read from (the latest of equal ones). */
type DecidedAllow = { readonly kind: "allow"; decision: unknown; value: JsonValue; readonly verdict: Allowed };

/** The last denial a decision read, with the object, reason and message it was read from. */
type DecidedDeny = {
	readonly kind: "deny";
	decision: unknown;
	readonly reason: string;
	message: unknown;
	readonly verdict: Denied;
};

/** What a decision read last: an allow or a denial. */
type Decided = DecidedAllow | DecidedDeny;

/**
 * The set of `listed` (not empty, grants of the contract whose grantable names are `grants`, in any order, repeated or
 * not): one per version and set of names while any decision has it, shared by every decision that grants them (a
 * thousand callers granted the same names keep one set), its names sorted. Found by a hash of the names' indexes and
 * compared name by name: a lookup makes no key (it sorted, deduped and serialized the names before). Held weakly: a
 * set goes with the last decision that granted it, its entry right after, and all of a version's with its contract.
 */
function grantedSet(grants: readonly string[], listed: readonly string[]): ReadonlySet<string> {
	let sets = grantedSets.get(grants);
	if (sets === undefined) {
		sets = new Map();
		grantedSets.set(grants, sets);
	}
	// A bit per index (modulo 31): order and repetition do not change it; exact up to 31 grants.
	let hash = 0;
	for (let index = 0; index < listed.length; index++) hash |= 1 << (grants.indexOf(listed[index]!) % 31);
	const bucket = sets.get(hash);
	if (bucket !== undefined) {
		for (let index = 0; index < bucket.length; index++) {
			const granted = bucket[index]!.deref();
			if (granted !== undefined && sameNames(listed, granted, grants)) return granted;
		}
	}
	// In the grants' order, which is sorted: a set's names iterate sorted.
	const granted: ReadonlySet<string> = new Set(grants.filter((name) => listed.includes(name)));
	const ref = new WeakRef(granted);
	if (bucket === undefined) sets.set(hash, [ref]);
	else bucket.push(ref);
	collectedSets.register(granted, { sets, hash, ref });
	return granted;
}

/** A version's granted sets by the hash of their names, each while a decision has it. */
type GrantedSets = Map<number, WeakRef<ReadonlySet<string>>[]>;

const grantedSets = new WeakMap<readonly string[], GrantedSets>();

/** Drops the entry of a collected set (its bucket with it when it was the last). */
const collectedSets = new FinalizationRegistry<{
	readonly sets: GrantedSets;
	readonly hash: number;
	readonly ref: WeakRef<ReadonlySet<string>>;
}>(({ sets, hash, ref }) => {
	const bucket = sets.get(hash);
	if (bucket === undefined) return;
	const index = bucket.indexOf(ref);
	if (index >= 0) bucket.splice(index, 1);
	if (bucket.length === 0) sets.delete(hash);
});

/**
 * Refuses `self.job` in an admitted type's factory (slice 14 §2.1), in an attempt and in staging: work for a person
 * outlives the person's access, so it lives in a `local` store, carries the person in its arguments and asks the
 * person's access again on every run.
 */
export function refuseAdmittedJob(served: Served, label: string): void {
	if (served.kind !== "remote" || served.admission === undefined) return;
	throw new Error(
		`${label}: self.job is not declared in an admitted object: work for a person lives in a local store`,
	);
}

/**
 * What a denial rejects the calls running for the denied caller with (slice 14 §2.2): `forbidden/revoked`, naming
 * `label` and the denial's reason, with its details (the message for the person, slice 15 §2). The denied object
 * itself shows `denial`, `forbidden` with the reason alone and the same details.
 */
export function revoked(label: string, denial: ChordError): ChordError {
	const { details } = denial;
	return new ChordError({ code: "forbidden", reason: "revoked", message: `${label}: ${denial.message}`, details });
}
