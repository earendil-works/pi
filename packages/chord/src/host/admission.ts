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
import {
	asChordError,
	canonicalText,
	checkParams,
	copyPlainJson,
	defineField,
	isMessageData,
	type PlainComparison,
	samePlainFields,
	samePlainJson,
	stackless,
} from "../data/internal.ts";
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

/** A decision without live queries has none to open: ready at once. */
const READY: Parking = { kind: "ready" };

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
	/** The last allow or denial it read, with what it keeps to compare the next read with (Chord's own, `Decided`). */
	#decided: Decided | undefined;
	/** Whether a change of its source waits for the current batch's flush: one check per batch. */
	#flushing = false;
	/** The pairs of a read's top-level fields, reused by the next read (`#takeFields`); made by the first with fields. */
	#scratch: unknown[] | undefined;
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
		const pinned = await pinKeys(this.#references, long, context);
		if (pinned !== undefined) return { kind: "parked", shown: pinned, firstPass: true, cause: pinned.cause };
		// Without live queries none is opened, in the same one turn an open of none took (its async frame and the
		// label cost 0.4 KiB per settle); nothing is followed: no wake is made.
		let opening: Parking | Promise<Parking> = READY;
		if (this.#readers.length > 0) {
			this.#readerWake ??= { invalidate: () => this.#owner.moved(), sourceRetired: () => {} };
			const label = `${this.#owner.label}: a live query of its admission`;
			opening = openReaders(this.#readers, this.#readerWake, long, label, context);
		}
		const reading = await opening;
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
		// Only for what takes it (its derives and live queries): a decision without any made one for nothing (0.3 KiB).
		const takers = this.#readers.length > 0 || this.#derives.length > 0;
		// Left out only when no loop below runs that takes it.
		const ended = (
			takers ? stackless({ code: "released", reason: "ended", message: `${label}: its admission ended` }) : undefined
		) as ChordError;
		this.#unfollow();
		// What it read its last decision from goes (the object, its value): only the verdict is kept, as before.
		const decided = this.#decided;
		if (decided !== undefined && decided.kind !== "released") {
			this.#decided = { kind: "released", verdict: decided.verdict };
		}
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
		const { kind, value, reason, message } = (decision ?? {}) as {
			kind?: unknown;
			value?: JsonValue;
			reason?: unknown;
			message?: unknown;
		};
		if (kind === "allow" && value !== undefined) {
			const { grants } = this.#owner;
			// A route's value goes on as it is; an object's is read against its contract's grants.
			if (grants === undefined) {
				countWalk(context);
				return this.#allowRoute(value);
			}
			return this.#allowObject(value, grants, label, context);
		}
		if (kind === "deny" && typeof reason === "string") {
			if (message !== undefined && !isMessageData(message, context)) {
				const error = new Error(`its denial's message is no message as data (MessageSchema): ${reason}`);
				return { kind: "broken", error: asChordError(error, label) };
			}
			countWalk(context);
			return this.#deny(reason, message);
		}
		const error = new Error("its admission's value is neither allow(value) nor deny(reason)");
		return { kind: "broken", error: asChordError(error, label) };
	}

	/**
	 * An object's allowed value, read in the order it was before the hot-path pass (`{ granted, ...data } = value`, the
	 * names checked in the list's own iteration and deduped in a second one, then the walk counted, then the data
	 * walked): its `granted` (a property read, whatever its enumerability), its top-level fields, the names checked (a
	 * refused value is broken and counts no walk) and taken, the walk counted (telemetry runs code of anyone's: what it
	 * changes of the value now is not this read's), then the data compared. Against a last allow kept plain, an equal
	 * read allocates nothing: the fields go into the decision's scratch list, the names are compared with the kept ones
	 * in their second pass; anything else is `#adoptAllow`'s.
	 */
	#allowObject(value: JsonValue, grants: readonly string[], label: string, context: Context): Verdict {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return brokenRead("its admission's value is an object (allow({ granted, ...data }))", label);
		}
		const listed: unknown = value.granted;
		const last = this.#lastAllow();
		const fields = last?.kind === "allowPlain" ? this.#takeFields(value) : undefined;
		try {
			// No plain last allow, or more fields than a scratch list holds: the data as a rest copy made it.
			const data = fields === undefined ? dataOf(value) : undefined;
			if (listed !== undefined) {
				if (!Array.isArray(listed)) return brokenRead("its admission's granted is a list of names", label);
				const refused = refusedNames(listed, grants, label);
				if (refused !== undefined) return refused;
			}
			const kept = last === undefined ? NO_ITEMS : namesOf(last.verdict.granted);
			const sameGrants =
				last?.kind === "allowPlain" && sameNames(listed as readonly unknown[] | undefined, kept) === "equal";
			// The second pass over the names, as `[...new Set(listed)].sort()` made it (a list's iterator may throw).
			const names = sameGrants ? kept : listed === undefined ? NO_ITEMS : [...new Set(listed as string[])].sort();
			countWalk(context);
			if (last?.kind === "allowPlain" && fields !== undefined) {
				if (sameGrants && samePlainFields(last.data, fields.list, fields.count) === "equal") return last.verdict;
				return this.#adoptAllow(fieldsData(value, fields), names, grants, last);
			}
			// Taken above when no plain allow was kept.
			return this.#adoptAllow(data!, names, grants, last);
		} finally {
			if (fields !== undefined) this.#giveFields(fields);
		}
	}

	/**
	 * `value`'s own enumerable string-keyed fields but `granted`, as key and value pairs in the decision's scratch list
	 * (taken: a read nested in this one makes its own); `undefined` for more than 128 (the caller copies them then).
	 */
	#takeFields(value: { readonly [field: string]: JsonValue }): Fields | undefined {
		let list = this.#scratch;
		this.#scratch = undefined;
		let count = 0;
		for (const key in value) {
			if (key === "granted" || !isEnumerable.call(value, key)) continue;
			if (count === 256) {
				if (list !== undefined) this.#giveFields({ list, count });
				return undefined;
			}
			list ??= [];
			list[count++] = key;
			list[count++] = value[key];
		}
		return { list: list ?? NO_ITEMS, count };
	}

	/** Puts the scratch list back, its pairs cleared: it keeps nothing of a plugin's value between reads. */
	#giveFields({ list, count }: Fields): void {
		if (list.length === 0) return;
		(list as unknown[]).fill(undefined, 0, count);
		this.#scratch = list as unknown[];
	}

	/** The last decision when it was an allow. */
	#lastAllow(): DecidedAllow | undefined {
		const decided = this.#decided;
		return decided?.kind === "allowPlain" || decided?.kind === "allowText" ? decided : undefined;
	}

	/** A route's allowed value, passed on as it is: compared with the last one's copy, else as `#adoptAllow` does. */
	#allowRoute(value: JsonValue): Allowed {
		const last = this.#lastAllow();
		if (last?.kind === "allowPlain" && samePlainJson(last.data, value) === "equal") return last.verdict;
		const copy = copyPlainJson(value);
		if (copy !== undefined && last?.kind !== "allowText") {
			if (last !== undefined && samePlainJson(last.data, copy) === "equal") return last.verdict;
			const verdict: Allowed = { kind: "allow", value, granted: NO_GRANTS };
			this.#decided = { kind: "allowPlain", verdict, data: copy };
			return verdict;
		}
		const key = canonicalText(value);
		if (last !== undefined && key === keptText(last)) return last.verdict;
		const verdict: Allowed = { kind: "allow", value, granted: NO_GRANTS };
		this.#decided = { kind: "allowText", verdict, key };
		return verdict;
	}

	/**
	 * An object's allow that is not the last one's plain value: its `data` (own enumerable fields but `granted`, taken
	 * before the walk was counted) and its `names` (sorted, without duplicates) compared with the last allow by Chord's
	 * copies when both are plain JSON, else by canonical JSON's text, made now (it throws where it threw) and kept.
	 * Equal, the last verdict; else a new one, its copy or text kept.
	 */
	#adoptAllow(
		data: { readonly [field: string]: JsonValue },
		names: readonly string[],
		grants: readonly string[],
		last: DecidedAllow | undefined,
	): Allowed {
		const copy = copyPlainJson(data);
		let key: string | undefined;
		if (copy !== undefined && last?.kind !== "allowText") {
			if (
				last !== undefined &&
				sameList(namesOf(last.verdict.granted), names) &&
				samePlainJson(last.data, copy) === "equal"
			) {
				return last.verdict;
			}
		} else {
			key = canonicalText(normalOf(data, names));
			if (last !== undefined && key === keptText(last)) return last.verdict;
		}
		const granted = names.length === 0 ? NO_GRANTS : grantedSet(grants, names);
		// What the factory is handed: the data's copy of its own (`dataOf`), with the set.
		defineField(data, "granted", granted);
		const verdict: Allowed = { kind: "allow", value: data as AdmittedValue, granted };
		this.#decided =
			key === undefined ? { kind: "allowPlain", verdict, data: copy } : { kind: "allowText", verdict, key };
		return verdict;
	}

	/**
	 * A denial (its message checked, its walk counted): compared with the last denial of the same reason by the copy of
	 * its message (plain JSON), else by the text of its reason and message as before, made now and kept.
	 */
	#deny(reason: string, message: unknown): Denied {
		const decided = this.#decided;
		// Another reason is another decision.
		const last =
			(decided?.kind === "denyPlain" || decided?.kind === "denyText") && decided.reason === reason
				? decided
				: undefined;
		if (last?.kind === "denyPlain" && sameMessage(last.message, message)) return last.verdict;
		const copy = message === undefined ? undefined : copyPlainJson(message);
		let key: string | undefined;
		if ((message === undefined || copy !== undefined) && last?.kind !== "denyText") {
			if (last !== undefined && sameMessage(last.message, copy)) return last.verdict;
		} else {
			// A structured key: a reason ending like a message's JSON is not that message.
			key = denyText(reason, message);
			const kept =
				last === undefined ? undefined : last.kind === "denyText" ? last.key : denyText(reason, last.message);
			if (last !== undefined && key === kept) return last.verdict;
		}
		// Checked by the caller: a message as data.
		const details = message === undefined ? undefined : { message: message as MessageData };
		const verdict: Denied = { kind: "deny", error: forbidden(reason, details) };
		this.#decided =
			key === undefined
				? { kind: "denyPlain", verdict, reason, message: copy }
				: { kind: "denyText", verdict, reason, key };
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
 * The first name of `listed` that is no grant of its contract, as what breaks (slice 15 §1.2; plugin code, bundled
 * without type checks), naming the contract and the name; `undefined` when every one is. Iterated as before the
 * hot-path pass, by the list's own iterator; a plain list (`Array.prototype`'s iterator) by index, which reads the
 * same and allocates no iterator.
 */
function refusedNames(
	listed: readonly unknown[],
	grants: readonly string[],
	label: string,
): Extract<Verdict, { readonly kind: "broken" }> | undefined {
	if (plainIteration(listed)) {
		for (let index = 0; index < listed.length; index++) {
			const refused = refusedName(listed[index], grants, label);
			if (refused !== undefined) return refused;
		}
		return undefined;
	}
	for (const name of listed) {
		const refused = refusedName(name, grants, label);
		if (refused !== undefined) return refused;
	}
	return undefined;
}

/** Whether `list` iterates as an index walk does: `Array.prototype`'s, with its iterator. */
function plainIteration(list: readonly unknown[]): boolean {
	return Object.getPrototypeOf(list) === Array.prototype && list[Symbol.iterator] === ARRAY_VALUES;
}

const ARRAY_VALUES = Array.prototype[Symbol.iterator];

function refusedName(
	name: unknown,
	grants: readonly string[],
	label: string,
): Extract<Verdict, { readonly kind: "broken" }> | undefined {
	if (typeof name === "string" && grants.includes(name)) return undefined;
	return brokenRead(
		`its admission granted ${JSON.stringify(name)}: no grantable member or flag of its contract`,
		label,
	);
}

function brokenRead(message: string, label: string): Extract<Verdict, { readonly kind: "broken" }> {
	return { kind: "broken", error: asChordError(new Error(message), label) };
}

/**
 * Whether `listed` (checked: none, or a list of grants) names exactly `kept` (sorted, without duplicates): absent and
 * empty are no names, repeated names and their order do not count. A bit per kept name, no allocation; `odd` for a
 * list that does not iterate as an index walk or more than 31 kept names (the caller reads it as before then).
 */
function sameNames(listed: readonly unknown[] | undefined, kept: readonly string[]): PlainComparison {
	if (listed === undefined) return kept.length === 0 ? "equal" : "different";
	if (kept.length > 31 || !plainIteration(listed)) return "odd";
	let seen = 0;
	for (let index = 0; index < listed.length; index++) {
		// `kept` is Chord's: no method of the plugin's list is called.
		const at = kept.indexOf(listed[index] as string);
		if (at < 0) return "different";
		seen |= 1 << at;
	}
	// 2 ** 31 - 1, not (1 << 31) - 1: a shift by 31 is negative.
	return seen === 2 ** kept.length - 1 ? "equal" : "different";
}

/** Whether two of Chord's sorted name lists are the same. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

/**
 * The data of an allowed value as before the hot-path pass (`{ granted, ...data } = value`, without its second read
 * of `granted`): its own enumerable fields but `granted`, symbols too, in their order.
 */
function dataOf(value: { readonly [field: string]: JsonValue }): { readonly [field: string]: JsonValue } {
	const data: { [field: string | symbol]: unknown } = {};
	for (const key of Reflect.ownKeys(value)) {
		if (key === "granted" || !isEnumerable.call(value, key)) continue;
		defineField(data, key, (value as { readonly [field: string | symbol]: unknown })[key]);
	}
	return data as { readonly [field: string]: JsonValue };
}

/** The pairs of a read's top-level fields taken into a scratch list (`#takeFields`): `count` entries of `list`. */
type Fields = { readonly list: readonly unknown[]; readonly count: number };

/**
 * The data `dataOf` makes, from fields taken before the walk was counted (in `Object.keys` order, which is their
 * order among the own keys) and the value's own enumerable symbol-keyed ones after them.
 */
function fieldsData(value: object, { list, count }: Fields): { readonly [field: string]: JsonValue } {
	const data: { [field: string | symbol]: unknown } = {};
	for (let index = 0; index < count; index += 2) defineField(data, list[index] as string, list[index + 1]);
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		if (isEnumerable.call(value, symbol))
			defineField(data, symbol, (value as { readonly [field: symbol]: unknown })[symbol]);
	}
	return data as { readonly [field: string]: JsonValue };
}

const isEnumerable = Object.prototype.propertyIsEnumerable;

/** What canonical JSON was made of for an allow before the hot-path pass: the data, with `granted` when it grants. */
function normalOf(data: { readonly [field: string]: unknown }, names: readonly string[]): JsonValue {
	return (names.length === 0 ? data : { ...data, granted: names }) as JsonValue;
}

/** The text of the last allow: kept, or made from Chord's own plain copy (which runs no code of anyone's). */
function keptText(last: DecidedAllow): string {
	if (last.kind === "allowText") return last.key;
	const { data, verdict } = last;
	// A route's copy is its value (it grants nothing); an object's its data, with the names it granted.
	const names = namesOf(verdict.granted);
	return canonicalText(
		names.length === 0 ? (data as JsonValue) : normalOf(data as { readonly [field: string]: unknown }, names),
	);
}

/** A denial's text: its reason, and its message when it has one. */
function denyText(reason: string, message: unknown): string {
	// A message as data (checked), or Chord's plain copy of one.
	return canonicalText(message === undefined ? [reason] : [reason, message as MessageData]);
}

/** Whether a denial's message is the kept one (Chord's copy): both none, or the same message as data. */
function sameMessage(kept: unknown, message: unknown): boolean {
	if (kept === undefined || message === undefined) return kept === message;
	return samePlainJson(kept, message) === "equal";
}

/** One walk of a decision's value per read, as canonical JSON counted it, before anything can throw. */
function countWalk(context: Context): void {
	chordMetrics(context.telemetry.metrics).counter("chord.data.walks").add(1);
}

/**
 * The last allow a decision read: its verdict and what the next read is compared with, all of it Chord's own, made when
 * the decision changed (never a reference into the plugin's value, which may change or go): its names (the verdict's
 * set) and a copy of its plain JSON (an object's data, a route's value), or the canonical JSON text made at that read.
 */
type DecidedAllow =
	| { readonly kind: "allowPlain"; readonly verdict: Allowed; readonly data: unknown }
	| { readonly kind: "allowText"; readonly verdict: Allowed; readonly key: string };

/** The last denial a decision read: its reason, a copy of its plain message (or none) or its text, and its verdict. */
type DecidedDeny =
	| { readonly kind: "denyPlain"; readonly verdict: Denied; readonly reason: string; readonly message: unknown }
	| { readonly kind: "denyText"; readonly verdict: Denied; readonly reason: string; readonly key: string };

/** What a decision read last: an allow or a denial; once released, only the verdict. */
type Decided = DecidedAllow | DecidedDeny | { readonly kind: "released"; readonly verdict: Allowed | Denied };

/**
 * The set of `names` (sorted, without duplicates, not empty, of the contract whose grantable names are `grants`): one
 * per version and set of names while any decision has it, shared by every decision that grants them (a thousand
 * callers granted the same names keep one set). Found by a hash of the names' indexes and compared name by name (no
 * key made per lookup). Held weakly: a set goes with the last decision that granted it, its entry right after, and
 * all of a version's with its contract.
 */
function grantedSet(grants: readonly string[], names: readonly string[]): ReadonlySet<string> {
	let sets = grantedSets.get(grants);
	if (sets === undefined) {
		const buckets: Buckets = new Map();
		// Drops the entry of a collected set (its bucket with it when it was the last).
		const collected = new FinalizationRegistry<{ readonly hash: number; readonly ref: WeakRef<ReadonlySet<string>> }>(
			({ hash, ref }) => {
				const bucket = buckets.get(hash);
				if (bucket === undefined) return;
				const index = bucket.indexOf(ref);
				if (index >= 0) bucket.splice(index, 1);
				if (bucket.length === 0) buckets.delete(hash);
			},
		);
		sets = { buckets, collected };
		grantedSets.set(grants, sets);
	}
	const { buckets } = sets;
	// A bit per index (modulo 31): exact up to 31 grants, compared name by name beyond.
	let hash = 0;
	for (let index = 0; index < names.length; index++) hash |= 1 << (grants.indexOf(names[index]!) % 31);
	const bucket = buckets.get(hash);
	if (bucket !== undefined) {
		for (let index = 0; index < bucket.length; index++) {
			const granted = bucket[index]!.deref();
			if (granted !== undefined && granted.size === names.length && names.every((name) => granted.has(name))) {
				return granted;
			}
		}
	}
	const granted: ReadonlySet<string> = new Set(names);
	setNames.set(granted, names);
	const ref = new WeakRef(granted);
	if (bucket === undefined) buckets.set(hash, [ref]);
	else bucket.push(ref);
	sets.collected.register(granted, { hash, ref });
	return granted;
}

/**
 * The sorted names of a granted set (`grantedSet`'s, or none): what a decision compares a read's names with, by
 * position. Kept with the set, weakly.
 */
function namesOf(granted: ReadonlySet<string>): readonly string[] {
	return setNames.get(granted) ?? NO_ITEMS;
}

const setNames = new WeakMap<ReadonlySet<string>, readonly string[]>();

/** A version's granted sets by the hash of their names, each while a decision has it. */
type Buckets = Map<number, WeakRef<ReadonlySet<string>>[]>;

/**
 * A version's buckets and the registry that drops a collected set's entry: owned by the version's entry alone (its
 * holdings name no table), so a set an app keeps keeps neither the buckets nor their registrations once the version is
 * gone.
 */
type GrantedSets = {
	readonly buckets: Buckets;
	readonly collected: FinalizationRegistry<{ readonly hash: number; readonly ref: WeakRef<ReadonlySet<string>> }>;
};

/** The granted sets of each version, by its grants: gone with the version. */
const grantedSets = new WeakMap<readonly string[], GrantedSets>();

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
