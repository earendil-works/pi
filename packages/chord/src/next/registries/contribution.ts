// One contributor's contribution to a registry (slice 8 §1): its table entry, made once per value (an older version's
// adapted once per value), followed when it is a Chord watchable, left out and reported when it fails or is refused.

import { type Dependent, type DeriveSource, handedOut, type NativeSource, Source } from "../state/internal.ts";
import type { RegistryRecord } from "./record.ts";
import type { RegistryEntry, RegistryProvider } from "./registry.ts";
import { RegistryValueSource } from "./value.ts";

/** Who contributes: a facet (by plugin) or a host-lifetime object (by plugin and type). */
export type Contributor = { readonly plugin: string; readonly type: string | undefined };

/**
 * What a contribution is: a plain value, a Chord JSON watchable (a source or a constant), or a native source; the
 * watchables followed for their value.
 */
export type ContributionContent =
	| { readonly kind: "plain"; readonly value: unknown }
	| { readonly kind: "json"; readonly source: DeriveSource }
	| { readonly kind: "native"; readonly source: NativeSource };

/**
 * One contributor's contribution to a registry: a plain value, or a Chord source it follows as a dependent (a change
 * marks the registry's table). Its table entry is made once per value (an older version's adapted once per value);
 * a failure or refusal leaves it out, reported once per episode.
 */
export class RegistryContribution implements Dependent {
	/** The registry it contributes to. */
	readonly record: RegistryRecord;
	readonly contributor: Contributor;
	/** The registry version its contributor was built against. */
	readonly version: number;
	readonly #content: ContributionContent;
	/** The last adaptation of an older contribution: the value it was made from and its result. */
	#adapted: { readonly from: unknown; readonly value: unknown } | undefined;
	#entry: RegistryEntry<unknown> | undefined;
	/** Left out since its last entry: failing (reported once), or refused (reported once). */
	#out: "none" | "failed" | "refused" = "none";

	constructor(record: RegistryRecord, contributor: Contributor, version: number, content: ContributionContent) {
		this.record = record;
		this.contributor = contributor;
		this.version = version;
		this.#content = content;
	}

	/** Its source changed (inside a batch): the registry's table is marked. */
	invalidate(): void {
		this.record.contributionChanged();
	}

	/** A retirement of its source's document changes nothing beyond the value. */
	sourceRetired(): void {}

	/** Starts following its source, if it has one. */
	follow(): void {
		const source = this.#followed();
		source?.dependents.add(this);
	}

	/** Stops following its source. */
	unfollow(): void {
		this.#followed()?.dependents.delete(this);
	}

	/** The registry whose value it is, when it is one (its edge in the cycle check, while it is in the table). */
	get reads(): RegistryRecord | undefined {
		const content = this.#content;
		return content.kind === "native" && content.source instanceof RegistryValueSource
			? content.source.record
			: undefined;
	}

	/** Its source when it changes (a constant never does). */
	#followed(): Source | NativeSource | undefined {
		const content = this.#content;
		if (content.kind === "native") return content.source;
		return content.kind === "json" && content.source instanceof Source ? content.source : undefined;
	}

	/**
	 * Its entry in a table of the provider at `version`: the same object while its value is the same; `undefined` when
	 * left out (a refused version, a failing source, a throwing adapter).
	 */
	entry(version: number, provider: RegistryProvider<unknown, unknown>): RegistryEntry<unknown> | undefined {
		const adapter = this.version < version ? provider.accepts?.[this.version]?.contribution : undefined;
		if (this.version > version || (this.version < version && adapter === undefined)) {
			if (this.#out !== "refused") this.#refused();
			return undefined;
		}
		let value: unknown;
		try {
			const raw = this.#raw();
			value = adapter === undefined ? raw : this.#adapt(raw, adapter);
		} catch (error) {
			if (this.#out !== "failed") this.#failed(error);
			return undefined;
		}
		this.#out = "none";
		const entry = this.#entry;
		// `undefined` is a value: the entry, not its field, says whether there was one.
		if (entry !== undefined && entry.value === value) return entry;
		const { plugin, type } = this.contributor;
		this.#entry = { plugin, ...(type === undefined ? {} : { type }), version: this.version, value };
		return this.#entry;
	}

	/**
	 * The contributed value now: a JSON source's value throws while it is failed or ended; a native source that failed
	 * (a registry whose `compose` threw) keeps a last good value for its readers, but is left out here as failed.
	 */
	#raw(): unknown {
		const content = this.#content;
		switch (content.kind) {
			case "plain":
				return content.value;
			case "json":
				return content.source.value;
			case "native":
				return content.source.current();
		}
	}

	#adapt(raw: unknown, adapter: (old: never) => unknown): unknown {
		const adapted = this.#adapted;
		if (adapted !== undefined && adapted.from === raw) return adapted.value;
		const value = this.record.adapt(() => adapter(raw as never));
		this.#adapted = { from: raw, value };
		return value;
	}

	#refused(): void {
		this.#out = "refused";
		const { plugin, type } = this.contributor;
		const registry = this.record.name;
		const where = type === undefined ? {} : { type };
		this.record.reportContribution({
			kind: "contribution_refused",
			registry,
			plugin,
			...where,
			version: this.version,
		});
	}

	#failed(error: unknown): void {
		this.#out = "failed";
		const { plugin, type } = this.contributor;
		const registry = this.record.name;
		const where = type === undefined ? {} : { type };
		this.record.reportContribution({
			kind: "contribution_failed",
			registry,
			plugin,
			...where,
			error: handedOut(error),
		});
	}
}
