// A registry on a host (slice 8 §1): its provider (replaced or removed by a reload, slice 7b §3), its contributions in table order (`contribution.ts`), the table
// and its lazy composition (marked when the table changes, composed when read or followed, in the batch's
// deliveries), the reports of conflicts and failures (once per episode), and the values its readers follow by
// version.

import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { type Batch, handedOut, type NativeStart } from "../state/internal.ts";
import type { RegistryContribution } from "./contribution.ts";
import type { ComposeContext, RegistryConflict, RegistryEntry, RegistryProvider, RegistryTable } from "./registry.ts";
import { RegistryValueSource } from "./value.ts";

/** What a registry reports to its host's `onError`, by kind; each once per episode. */
export type RegistryError =
	/** `compose` reported a conflict it resolved. */
	| {
			readonly kind: "registry_conflict";
			readonly registry: string;
			readonly message: string;
			readonly plugins: readonly string[];
	  }
	/** `compose` (or an older version's `value` adapter) threw: the last good composition stays. */
	| { readonly kind: "registry_failed"; readonly registry: string; readonly error: unknown }
	/** A watchable contribution failed or ended, or its `contribution` adapter threw: it is left out until it heals. */
	| {
			readonly kind: "contribution_failed";
			readonly registry: string;
			readonly plugin: string;
			readonly type?: string;
			readonly error: unknown;
	  }
	/** A contribution of a version the provider does not accept (newer, or older without an adapter) is left out. */
	| {
			readonly kind: "contribution_refused";
			readonly registry: string;
			readonly plugin: string;
			readonly type?: string;
			readonly version: number;
	  };

/** The provider as served: the defining plugin's version, `compose` and adapters. */
type Provider = { readonly version: number; readonly provider: RegistryProvider<unknown, unknown> };

/**
 * Where a composition stands: never composed, its last good value (with the contributions it was built from), and its
 * failure while `compose` throws.
 */
type Composition = {
	readonly good: { readonly value: unknown; readonly from: readonly RegistryContribution[] } | undefined;
	readonly failure: { readonly error: unknown } | undefined;
};

const NEVER: Composition = { good: undefined, failure: undefined };

/**
 * Checks a registry provider as a setup served it (declaration policy: plugin code is bundled without type checks):
 * `compose` is a function.
 */
export function checkProvider(name: string, provider: RegistryProvider<unknown, unknown>): void {
	if (typeof provider?.compose !== "function") throw new Error(`registry ${name}: compose is a function`);
}

/** One registry of a host. */
export class RegistryRecord {
	readonly name: string;
	readonly #batch: Batch;
	readonly #report: (error: RegistryError) => void;
	#provider: Provider | undefined;
	/** The contributions of live contributors, sorted by plugin, then type (a facet's first). */
	#contributions: readonly RegistryContribution[] = [];
	/** The last table composed, kept so an unchanged table composes nothing. */
	#table: RegistryTable<unknown> | undefined;
	#dirty = true;
	#composition: Composition = NEVER;
	/** Set while its table is built and composed: a read then is a cycle of registries. */
	#composing = false;
	/** The conflicts the last good composition reported, by key: a conflict is reported once per episode. */
	#conflicts = new Set<string>();
	/** The values readers follow, by version; made by the first reader of a version. */
	readonly #values = new Map<number, RegistryValueSource>();

	constructor(name: string, batch: Batch, report: (error: RegistryError) => void) {
		this.name = name;
		this.#batch = batch;
		this.#report = report;
	}

	/** The provider's version; `undefined` while none serves it. */
	get providedVersion(): number | undefined {
		return this.#provider?.version;
	}

	/** The value readers of `version` follow. */
	value(version: number): RegistryValueSource {
		let value = this.#values.get(version);
		if (value === undefined) {
			value = new RegistryValueSource(this, version, this.#batch);
			this.#values.set(version, value);
		}
		return value;
	}

	/**
	 * Serves the registry with `provider` at `version` (the defining plugin's facet, checked by `checkProvider` when
	 * its setup ran), replacing the provider a reload changed, inside a batch: the table composes again (lazily).
	 */
	serve(version: number, provider: RegistryProvider<unknown, unknown>): void {
		this.#provider = { version, provider };
		this.#table = undefined;
		this.#invalidate();
	}

	/**
	 * A reload removed the defining plugin, inside a batch: no provider serves it; its readers' values fail
	 * `unavailable/undeclared` (a reader parked on it waits `not_served`), its contributions stay in the table.
	 */
	unserve(): void {
		this.#provider = undefined;
		this.#table = undefined;
		this.#composition = NEVER;
		this.#invalidate();
	}

	/** The first composition of a served registry, at `load`'s publication or a reload's commit, inside its batch. */
	composeServed(): void {
		if (this.#provider === undefined) return;
		this.start();
	}

	/** Adds a live contributor's contribution, inside a batch: the table changes. */
	add(contribution: RegistryContribution): void {
		const at = this.#contributions.findIndex((other) => compareContributors(contribution, other) < 0);
		// A new list per change (contributors come and go rarely): a composition keeps the one it was built from.
		this.#contributions = this.#contributions.toSpliced(at < 0 ? this.#contributions.length : at, 0, contribution);
		contribution.follow();
		this.#invalidate();
	}

	/** Removes an ending contributor's contribution, inside a batch: the table changes. */
	remove(contribution: RegistryContribution): void {
		const at = this.#contributions.indexOf(contribution);
		if (at < 0) return;
		this.#contributions = this.#contributions.toSpliced(at, 1);
		contribution.unfollow();
		this.#invalidate();
	}

	/** A followed contribution changed, inside a batch: the table is marked, composed when read or followed. */
	contributionChanged(): void {
		this.#invalidate();
	}

	/**
	 * The current composition, composed now when the table changed: the value, or `compose`'s failure with the last
	 * good one; `unavailable/undeclared` while no provider serves it. A read while it composes is a cycle.
	 */
	start(): NativeStart<unknown> {
		if (this.#composing) throw invalid("cycle", `registry ${this.name} is read while it composes`);
		if (this.#provider === undefined) {
			const error = new ChordError({
				code: "unavailable",
				reason: "undeclared",
				message: `registry ${this.name}: no plugin serves it here`,
			});
			return { kind: "failed", error, last: undefined };
		}
		if (this.#dirty) this.#recompose(this.#provider);
		const { good, failure } = this.#composition;
		if (failure !== undefined) return { kind: "failed", error: failure.error, last: good };
		// A composition without a failure has a value.
		return { kind: "value", value: good!.value };
	}

	/** The contributions the current good composition was built from; `undefined` while there is none. */
	get composedFrom(): readonly RegistryContribution[] | undefined {
		return this.#composition.good?.from;
	}

	/**
	 * Whether every contribution of `from` (what a composition, or a mapping of it, was built from) is still in the
	 * table (decision 5: one that left may have closed the native its entry held).
	 */
	inTable(from: readonly RegistryContribution[]): boolean {
		const current = this.#contributions;
		return from === current || from.every((each) => current.includes(each));
	}

	/** The adapter mapping the composed value back for readers of `version`; `undefined` when there is none. */
	valueAdapter(version: number): ((current: never) => unknown) | undefined {
		return this.#provider?.provider.accepts?.[version]?.value;
	}

	/** Runs an adapter of the provider as a pure compute, counted. */
	adapt<T>(adapter: () => T): T {
		this.#batch.count("chord.registry.adapts");
		return this.#batch.compute(adapter);
	}

	/** Reports a contribution left out (`contribution_failed`, `contribution_refused`; the caller keeps the episode). */
	reportContribution(error: RegistryError): void {
		this.#report(error);
	}

	/** Reports a throw of `compose` or of a value adapter (`registry_failed`; the caller keeps the episode). */
	failed(error: unknown): void {
		this.#report({ kind: "registry_failed", registry: this.name, error: handedOut(error) });
	}

	/**
	 * The host closed: the contributions stop following their sources, the values end (a value kept by a reader still
	 * reads the last composition).
	 */
	close(): void {
		for (const contribution of this.#contributions) contribution.unfollow();
		this.#contributions = [];
		this.#table = undefined;
		this.#dirty = false;
		for (const value of this.#values.values()) value.close();
		this.#values.clear();
	}

	/**
	 * The table changed: every version's value is marked and listed (each lists itself once per batch); while it is
	 * not composed since an earlier change, only listed (its dependents are marked already).
	 */
	#invalidate(): void {
		if (this.#dirty) {
			for (const value of this.#values.values()) value.relisted();
			return;
		}
		this.#dirty = true;
		for (const value of this.#values.values()) value.recomposed();
	}

	/**
	 * Builds the table and composes it, unless it is the last one composed, entry for entry (`compose` is pure). A
	 * throw is a failure episode: reported once, the last good composition kept while every contribution it was built
	 * from is still in the table (decision 5: one whose contributor ended may hold a closed native); conflicts are
	 * reported once per episode, as their message and plugins.
	 */
	#recompose({ version, provider }: Provider): void {
		this.#dirty = false;
		this.#composing = true;
		try {
			const table = this.#build(version, provider);
			if (table === this.#table && this.#composition !== NEVER) return;
			this.#table = table;
			const conflicts = new Map<string, RegistryConflict>();
			const context: ComposeContext = {
				report: (conflict) =>
					conflicts.set(`${conflict.message}\u0000${conflict.plugins.join("\u0000")}`, conflict),
			};
			let value: unknown;
			try {
				this.#batch.count("chord.registry.composes");
				value = this.#batch.compute(() => provider.compose(table, context));
			} catch (error) {
				if (this.#composition.failure === undefined) this.failed(error);
				const { good } = this.#composition;
				this.#composition = {
					good: good !== undefined && this.inTable(good.from) ? good : undefined,
					failure: { error },
				};
				return;
			}
			this.#composition = { good: { value, from: this.#contributions }, failure: undefined };
			for (const [key, conflict] of conflicts) {
				if (this.#conflicts.has(key)) continue;
				this.#report({ kind: "registry_conflict", registry: this.name, ...conflict });
			}
			this.#conflicts = new Set(conflicts.keys());
		} finally {
			this.#composing = false;
		}
	}

	/** The table of the live contributions now; the last one itself when every entry is the same object. */
	#build(version: number, provider: RegistryProvider<unknown, unknown>): RegistryTable<unknown> {
		const previous = this.#table;
		const table: RegistryEntry<unknown>[] = [];
		let same = previous !== undefined;
		for (const contribution of this.#contributions) {
			const entry = contribution.entry(version, provider);
			if (entry === undefined) continue;
			if (same && previous![table.length] !== entry) same = false;
			table.push(entry);
		}
		return same && previous!.length === table.length ? previous! : table;
	}
}

/** Table order: by plugin name, then type, a facet (no type) first; code point order, never load order. */
function compareContributors(a: RegistryContribution, b: RegistryContribution): number {
	const left = a.contributor;
	const right = b.contributor;
	if (left.plugin !== right.plugin) return left.plugin < right.plugin ? -1 : 1;
	const leftType = left.type ?? "";
	const rightType = right.type ?? "";
	if (leftType === rightType) return 0;
	return leftType < rightType ? -1 : 1;
}
