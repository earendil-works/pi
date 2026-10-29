// Registry values (slice 8 §1 "Reading", S2, S3): a registry's composed value as the readers of one version see it, a
// native source. The provider's version reads the composition itself; an older one reads it mapped back with
// `accepts[old].value`, once per composition, kept only while someone reads or follows it; a version the provider
// cannot serve fails `contract_mismatch`. Its readers (attempts that declared it) keep the mapping; its waiters
// (attempts parked on it, a waiting `host.registry`) are woken at every change of whether it is usable, and of its
// failure while it is not (dependency model §9).

import { ChordError, isChordError } from "../data/index.ts";
import { type Batch, FollowedSource, type NativeStart } from "../state/internal.ts";
import type { RegistryContribution } from "./contribution.ts";
import type { RegistryRecord } from "./record.ts";

/** Who waits for a registry's value (a parked attempt, a `host.registry`): told when it may have changed. */
export interface RegistryWaiter {
	/** The value may have changed (inside its batch: it only records). */
	dependencyMoved(): void;
	/** The value closed with its host: the wait ends with `error` (`released/closed`). */
	closed(error: ChordError): void;
}

const USABLE = { kind: "usable" } as const;

/** Whether two failures say the same: the same error, or ChordErrors alike (a version mismatch is made per read). */
function sameError(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return isChordError(a) && isChordError(b) && a.code === b.code && a.reason === b.reason && a.message === b.message;
}

/**
 * The last good mapping for an older version, the composition it was made from, and the contributions that composition
 * was built from (kept only while all are in the table, decision 5).
 */
type Mapped = {
	readonly from: unknown;
	readonly value: unknown;
	readonly contributions: readonly RegistryContribution[] | undefined;
};

/** A failed mapping of composition `from`, until another composition maps. */
type MapFailure = { readonly from: unknown; readonly error: unknown };

/**
 * Where a value's registry stands for it: on the host, or closed with the host (its last start kept, the record let
 * go, so a value an app keeps keeps no closed host).
 */
type Registered =
	| { readonly kind: "open"; readonly record: RegistryRecord }
	| { readonly kind: "closed"; readonly last: NativeStart<unknown> };

/** One version's view of a registry's composed value. */
export class RegistryValueSource extends FollowedSource<unknown> {
	readonly name: string;
	readonly version: number;
	#registered: Registered;
	/** Its readers, each a token of its own (one object may read twice), until released. */
	readonly #readers = new Set<object>();
	/** Its waiters, each a token of its own, until released. */
	readonly #waiters = new Set<{ readonly waiter: RegistryWaiter }>();
	/**
	 * What its waiters were last told: usable (a value, or a failure with a last good one), or the error it has none
	 * for; a change wakes them.
	 */
	#told: { readonly kind: "usable" } | { readonly kind: "failed"; readonly error: unknown } | undefined;
	#mapped: Mapped | undefined;
	#mapFailure: MapFailure | undefined;

	constructor(record: RegistryRecord, version: number, batch: Batch) {
		super(batch);
		this.name = record.name;
		this.version = version;
		this.#registered = { kind: "open", record };
	}

	/** Its registry's record while the host is open. */
	get record(): RegistryRecord | undefined {
		const registered = this.#registered;
		return registered.kind === "open" ? registered.record : undefined;
	}

	/** The composition (or its mapping) at its last good value; throws the failure when there is none. */
	get value(): unknown {
		const start = this.start();
		if (start.kind === "value") return start.value;
		if (start.last === undefined) throw start.error;
		return start.last.value;
	}

	/**
	 * Its composition (mapped for an older version), composed now if its table changed; a change of whether it is
	 * usable, or of its failure while it is not, wakes its waiters.
	 */
	override start(): NativeStart<unknown> {
		const registered = this.#registered;
		if (registered.kind === "closed") return registered.last;
		const start = this.#start(registered.record);
		if (this.#waiters.size > 0) this.#tell(start);
		return start;
	}

	/** Its composition (or mapping) now; throws while it is failed, though `.value` keeps the last good one. */
	override current(): unknown {
		const start = this.start();
		if (start.kind === "failed") throw start.error;
		return start.value;
	}

	/** Followed while someone watches or observes it, and while waiters wait on it. */
	override get watched(): boolean {
		return super.watched || this.#waiters.size > 0;
	}

	/** Registers a reader (an attempt that declared it) until the returned release: its mapping is kept meanwhile. */
	read(): () => void {
		const token = {};
		this.#readers.add(token);
		return () => {
			this.#readers.delete(token);
			if (this.#readers.size === 0 && !super.watched) this.#dropMapping();
		};
	}

	/**
	 * Registers `waiter` (a parked attempt's object, a waiting `host.registry`) until the returned release: it is told
	 * of every change of whether this value is usable (inside the batch that made it: it only records).
	 */
	wait(waiter: RegistryWaiter): () => void {
		const token = { waiter };
		if (this.#waiters.size === 0) this.#told = undefined;
		this.#waiters.add(token);
		return () => {
			this.#waiters.delete(token);
			if (this.#waiters.size === 0) this.#told = undefined;
		};
	}

	/** The registry's table changed (inside a batch): its dependents are marked, its followers get the next frame. */
	recomposed(): void {
		this.changed();
	}

	/**
	 * The registry's table changed again while not composed since (inside a batch): its dependents are marked already
	 * (none read it meanwhile, or it would be composed); its followers get the next frame. Marking stops here, so a
	 * cycle of registries through their values ends.
	 */
	relisted(): void {
		this.list();
	}

	/** The host closed: its watches and observers end, its readers and mapping go; it keeps its last start only. */
	close(): void {
		let last: NativeStart<unknown>;
		try {
			last = this.start();
		} catch (error) {
			last = { kind: "failed", error, last: undefined };
		}
		this.#registered = { kind: "closed", last };
		this.#readers.clear();
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		const error = new ChordError({ code: "released", reason: "closed", message: `registry ${this.name}: closed` });
		for (const { waiter } of waiters) waiter.closed(error);
		this.#told = undefined;
		this.#dropMapping();
		this.end();
	}

	/** Nobody follows it: without readers, its mapping goes (computed again on the next read). */
	protected override unfollowed(): void {
		if (this.#readers.size === 0) this.#dropMapping();
	}

	/** Wakes the waiters when `start` says something else than they were told (by usability, then by the error). */
	#tell(start: NativeStart<unknown>): void {
		const told = this.#told;
		const usable = start.kind === "value" || start.last !== undefined;
		if (usable ? told?.kind === "usable" : told?.kind === "failed" && sameError(told.error, start.error)) return;
		this.#told = usable ? USABLE : { kind: "failed", error: (start as { readonly error: unknown }).error };
		// The first start of a wait wakes nobody: the waiter reads it itself.
		if (told === undefined) return;
		for (const { waiter } of this.#waiters) waiter.dependencyMoved();
	}

	#dropMapping(): void {
		this.#mapped = undefined;
		this.#mapFailure = undefined;
	}

	#start(record: RegistryRecord): NativeStart<unknown> {
		const provided = record.providedVersion;
		if (provided === undefined || provided === this.version) return record.start();
		const map = provided > this.version ? record.valueAdapter(this.version) : undefined;
		if (map === undefined) {
			const message = `registry ${this.name}: version ${this.version} is not served here (version ${provided} is)`;
			return { kind: "failed", error: new ChordError({ code: "contract_mismatch", message }), last: undefined };
		}
		return this.#mappedStart(record, record.start(), map);
	}

	/**
	 * The composition `current` mapped back with `map`, once per composition; a throwing mapping fails this version
	 * only (reported once per episode), keeping its last good mapping; a composition mapped before heals it.
	 */
	#mappedStart(
		record: RegistryRecord,
		current: NativeStart<unknown>,
		map: (current: never) => unknown,
	): NativeStart<unknown> {
		if (current.kind === "failed" && current.last === undefined) return current;
		const from = current.kind === "value" ? current.value : current.last!.value;
		// `undefined` is a composition too: the records, not their fields, say whether there is one.
		// A mapping built from a contribution that left is no last good value any more (decision 5).
		if (this.#mapped?.contributions !== undefined && !record.inTable(this.#mapped.contributions)) {
			this.#mapped = undefined;
		}
		const mapped = this.#mapped;
		const failure = this.#mapFailure;
		if (mapped !== undefined && mapped.from === from) {
			this.#mapFailure = undefined;
		} else if (failure === undefined || failure.from !== from) {
			try {
				const value = record.adapt(() => map(from as never));
				this.#mapped = { from, value, contributions: record.composedFrom };
				this.#mapFailure = undefined;
			} catch (error) {
				if (failure === undefined) record.failed(error);
				this.#mapFailure = { from, error };
			}
		}
		const last = this.#mapped === undefined ? undefined : { value: this.#mapped.value };
		if (this.#mapFailure !== undefined) return { kind: "failed", error: this.#mapFailure.error, last };
		if (current.kind === "failed") return { kind: "failed", error: current.error, last };
		return { kind: "value", value: last!.value };
	}
}
