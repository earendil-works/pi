// Adapted members (Q10, §22, slice 7b §7; decision "References are the only indirection" (5)): one object instance's
// shared mapping for the consumers of one older version its provider accepts. Per state member one derive of the
// instance's member through `(current) => old` (a changed member), of its variant's whole state through `(state) => old`
// (a removed member), or the member itself (unchanged), made on first use; per key of a keyed member one derive of the
// key's document through the member's mapping, shared by the references holding it. One map and one diff per commit
// per version, whatever the number of old references. Dropped when no reference of the version is left, gone with the
// instance; references move to a new instance's mappings as to any new instance. A version the provider does not
// accept, or a refused member, gives no member (`contract_mismatch`): its consumers wait unbound.

import type { JsonValue } from "../../json.ts";
import type { Contract } from "../contracts/index.ts";
import { currentVariants, LOCAL, variantsAt } from "../contracts/internal.ts";
import { ChordError } from "../data/index.ts";
import type { Batch } from "../state/batch.ts";
import { Derive, type DeriveSource } from "../state/internal.ts";
import type { Served } from "./object.ts";

/** A state mapping as an accepts table holds it (checked by `checkAccepts`). */
type StateMapping = ((current: never) => unknown) | "refuse";

/** One older version's mappings, as `checkAccepts` checked them: remote state by variant, local state flat. */
type VersionMappings = {
	readonly state?: { readonly [key: string]: StateMapping | { readonly [member: string]: StateMapping } };
	readonly keyed?: { readonly [member: string]: StateMapping };
};

/** What the mappings of one instance read: its provider, its variant, its own members, its host's batch and reports. */
export type AdaptedInstance = {
	readonly served: Served;
	readonly variant: string | undefined;
	readonly label: string;
	readonly batch: Batch;
	/** The instance's state member `member` (`invalid/member` when its variant has none). */
	member(member: string): DeriveSource;
	/** Reports a mapping derive's failure (`derive_failed`). */
	report(member: string, error: unknown): void;
};

/** A key's mapping derive, shared by the references holding the key at this version. */
type MappedKey = { readonly derive: Derive; holders: number };

/**
 * Why consumers of the older `version` cannot bind to `served`'s `variant`: a version it does not accept, or a member
 * of it the provider refuses (`contract_mismatch`); `undefined` when they can.
 */
export function refusal(served: Served, version: number, variant: string | undefined): ChordError | undefined {
	const { contract, provider } = served;
	if (!provider.accepted.some((accepted) => accepted.version === version)) {
		return new ChordError({ code: "contract_mismatch", message: `${contract.name} v${version} is not served here` });
	}
	const mappings = mappingsOf(served, version);
	const old = variantsAt(contract, version).get(variant ?? LOCAL);
	for (const member of old?.state.keys() ?? []) {
		if (stateMapping(served, mappings, variant, member) === "refuse") return refused(contract, version, member);
	}
	for (const member of old?.keyed.keys() ?? []) {
		if (mappings?.keyed?.[member] === "refuse") return refused(contract, version, member);
	}
	return undefined;
}

/** One instance's members as the consumers of one older version read them. */
export class AdaptedMembers {
	readonly version: number;
	readonly #instance: AdaptedInstance;
	/** The members read so far: a mapping derive, or the instance's member itself (unchanged). */
	readonly #members = new Map<string, DeriveSource>();
	/** The mapping derives it made (an unchanged member is the instance's own: it never detaches that one). */
	readonly #derives = new Set<Derive>();
	/** The keys held so far, by the instance's key document. */
	#keys: Map<string, Map<DeriveSource, MappedKey>> | undefined;

	constructor(instance: AdaptedInstance, version: number) {
		this.#instance = instance;
		this.version = version;
	}

	/**
	 * State member `member` as this version reads it, made by the first use; `contract_mismatch` when the provider
	 * refuses it or does not accept this version.
	 */
	member(member: string): DeriveSource {
		const made = this.#members.get(member);
		if (made !== undefined) return made;
		const source = this.#make(member);
		this.#members.set(member, source);
		return source;
	}

	/**
	 * The document `document` at a key of keyed member `member` as this version reads it: the document itself when
	 * unchanged, else a derive of it through the mapping, shared by its holders; `release` (once per call) lets the last
	 * holder's go. `contract_mismatch` when the provider refuses the member.
	 */
	key(member: string, document: DeriveSource): { readonly source: DeriveSource; release(): void } {
		const mapping = this.#keyed(member);
		if (mapping === undefined) return { source: document, release: () => {} };
		this.#keys ??= new Map();
		const keys = this.#keys;
		// By member, then document: two keyed members over one handle map the same document differently (Astra).
		let found = keys.get(member);
		if (found === undefined) {
			found = new Map();
			keys.set(member, found);
		}
		const byDocument = found;
		let held = byDocument.get(document);
		if (held === undefined) {
			const { batch } = this.#instance;
			const derive = new Derive([document], ([value]) => mapping(value as JsonValue), batch);
			// A failure of the mapping is the reader's (its watch gets it); nothing to report for the provider.
			derive.attach(
				(declared) => declared as DeriveSource,
				() => {},
			);
			held = { derive, holders: 0 };
			byDocument.set(document, held);
		}
		held.holders++;
		const key = held;
		let released = false;
		return {
			source: key.derive,
			release: () => {
				if (released) return;
				released = true;
				if (--key.holders > 0 || byDocument.get(document) !== key) return;
				byDocument.delete(document);
				if (byDocument.size === 0 && keys.get(member) === byDocument) keys.delete(member);
				key.derive.detach(ended(this.#instance.label));
			},
		};
	}

	/**
	 * The provider's mapping of keyed member `member`'s documents to this version's shape (`undefined`: unchanged),
	 * counted; throws `contract_mismatch` when the provider refuses it.
	 */
	keyed(member: string): ((current: JsonValue) => JsonValue) | undefined {
		return this.#keyed(member);
	}

	/** Its instance ended, or the version's last reference left: its derives go (their watches end with `error`). */
	detach(error: Error): void {
		for (const derive of this.#derives) derive.detach(error);
		this.#derives.clear();
		this.#members.clear();
		for (const byDocument of this.#keys?.values() ?? []) {
			for (const { derive } of byDocument.values()) derive.detach(error);
		}
		this.#keys = undefined;
	}

	/** The mapping of keyed member `member`, counted; `contract_mismatch` when refused. */
	#keyed(member: string): ((current: JsonValue) => JsonValue) | undefined {
		this.#assertAccepted();
		const mapping = this.#mappings?.keyed?.[member];
		if (mapping === undefined) return undefined;
		if (mapping === "refuse") throw refused(this.#contract, this.version, member);
		const { batch } = this.#instance;
		return (current) => {
			batch.count("chord.contract.adapts");
			// The provider's mapping, typed by its contract; its result is the old shape (not validated).
			return mapping(current as never) as JsonValue;
		};
	}

	/**
	 * What `member` is at this version: the instance's member itself (unchanged), or a derive through the mapping, of the
	 * member when the current variant has it, else of the variant's whole current state (a removed member).
	 */
	#make(member: string): DeriveSource {
		this.#assertAccepted();
		const instance = this.#instance;
		const { variant, batch } = instance;
		const mapping = stateMapping(instance.served, this.#mappings, variant, member);
		if (mapping === undefined) return instance.member(member);
		if (mapping === "refuse") throw refused(this.#contract, this.version, member);
		const map = (value: unknown): JsonValue => {
			batch.count("chord.contract.adapts");
			// The provider's mapping, typed by its contract; its result is the old member's shape (not validated).
			return mapping(value as never) as JsonValue;
		};
		const current = currentVariants(this.#contract).get(variant ?? LOCAL)!;
		// The member when the current variant has it, else the variant's whole current state (a removed member).
		const kept = current.state.has(member);
		const names = kept ? [member] : [...current.state.keys()];
		const sources = names.map((name) => instance.member(name));
		const derive = kept
			? new Derive(sources, ([value]) => map(value), batch)
			: new Derive(
					sources,
					(values) => map(Object.fromEntries(names.map((name, index) => [name, values[index]]))),
					batch,
				);
		this.#derives.add(derive);
		// The sources are the instance's members already.
		derive.attach(
			(source) => source as DeriveSource,
			(error) => instance.report(member, error),
		);
		return derive;
	}

	/** Throws `contract_mismatch` unless the provider accepts this version. */
	#assertAccepted(): void {
		const { contract, provider } = this.#instance.served;
		if (provider.accepted.some(({ version }) => version === this.version)) return;
		throw new ChordError({
			code: "contract_mismatch",
			message: `${contract.name} v${this.version} is not served here`,
		});
	}

	get #contract(): Contract {
		return this.#instance.served.contract;
	}

	/** This version's mappings in the provider's accepts table. */
	get #mappings(): VersionMappings | undefined {
		return mappingsOf(this.#instance.served, this.version);
	}
}

/** `version`'s mappings in `served`'s accepts table. */
function mappingsOf(served: Served, version: number): VersionMappings | undefined {
	// `checkAccepts` established the table's shape.
	const accepts = served.provider.accepts as { readonly [version: number]: VersionMappings };
	return accepts[version];
}

/** The mapping of state member `member` of `variant` in `mappings`; `undefined` when it is unchanged. */
function stateMapping(
	served: Served,
	mappings: VersionMappings | undefined,
	variant: string | undefined,
	member: string,
): StateMapping | undefined {
	const state = mappings?.state;
	if (state === undefined) return undefined;
	if (served.contract.kind === "local") return state[member] as StateMapping | undefined;
	const section = state[variant ?? ""] as { readonly [member: string]: StateMapping } | undefined;
	return section?.[member];
}

/** The `contract_mismatch` of a member of `version` the provider refuses. */
function refused(contract: Contract, version: number, member: string): ChordError {
	return new ChordError({
		code: "contract_mismatch",
		message: `${contract.name} v${version}: member "${member}" is refused by its provider`,
	});
}

/** The `released` error its derives end with when its instance or version goes. */
function ended(label: string): ChordError {
	return new ChordError({ code: "released", reason: "ended", message: `${label}: ended` });
}
