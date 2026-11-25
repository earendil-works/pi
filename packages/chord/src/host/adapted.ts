// Adapted members (Q10, §22, slice 7b §7; decision "References are the only indirection" (5)): one object instance's
// shared mapping for the consumers of one older version its provider accepts. Per state member one derive of the
// instance's member through `(current) => old` (a changed member), of the whole state its caller was granted through
// `(state) => old` (a removed member), or the member itself (unchanged), made on first use; per key of a keyed member
// one derive of the key's document through the member's mapping, shared by the references holding it; per changed event
// member one node mapping each value once per emit (decision "Events: fire-and-forget members"). One map and one diff
// per commit per version, whatever the number of old references. Dropped when no reference of the version is left, gone
// with the instance; references move to a new instance's mappings as to any new instance. A version the provider does
// not accept, or a refused member, gives no member (`contract_mismatch`): its consumers wait unbound.

import type { Contract } from "../contracts/index.ts";
import { currentVersion, grantedMembers, versionAt } from "../contracts/internal.ts";
import { ChordError } from "../data/index.ts";
import type { JsonValue } from "../json.ts";
import type { Batch } from "../state/batch.ts";
import { Derive, type DeriveSource } from "../state/internal.ts";
import type { ChordMetrics } from "../telemetry.ts";
import { type EventEntry, type EventFlush, EventNode, type Tap } from "./events.ts";
import { lacking } from "./members.ts";
import type { Served } from "./object.ts";

/** A state mapping as an accepts table holds it (checked by `checkAccepts`). */
type StateMapping = ((current: never) => unknown) | "refuse";

/** One older version's mappings, as `checkAccepts` checked them. */
type VersionMappings = {
	readonly state?: { readonly [member: string]: StateMapping };
	readonly keyed?: { readonly [member: string]: StateMapping };
	readonly events?: { readonly [member: string]: StateMapping };
};

/**
 * What the mappings of one instance read: its provider, what its caller was granted, its own members, its host's batch
 * and reports.
 */
export type AdaptedInstance = {
	readonly served: Served;
	readonly granted: ReadonlySet<string>;
	readonly label: string;
	readonly batch: Batch;
	/** The instance's state member `member` (failing when it lacks it). */
	member(member: string): DeriveSource;
	/** The instance's event member `member`'s node; `undefined` when it lacks it. */
	event(member: string): EventNode | undefined;
	/** Reports a mapping derive's failure (`derive_failed`). */
	report(member: string, error: unknown): void;
	/** Reports an event mapping's failure (`event_mapping_failed`), once per failure episode. */
	reportEvent(member: string, error: unknown): void;
	/** The host's instruments: an event dropped by its mapping is counted (`chord.events.dropped`). */
	readonly metrics: ChordMetrics;
};

/** A key's mapping derive, shared by the references holding the key at this version. */
type MappedKey = { readonly derive: Derive; holders: number };

/**
 * Why consumers of the older `version` cannot bind to an instance of `served` granted `granted`: a version it does not
 * accept, or a member of it the provider refuses (`contract_mismatch`); `undefined` when they can.
 */
export function refusal(served: Served, version: number, granted: ReadonlySet<string>): ChordError | undefined {
	const { contract, provider } = served;
	if (!provider.accepted.some((accepted) => accepted.version === version)) {
		return new ChordError({ code: "contract_mismatch", message: `${contract.name} v${version} is not served here` });
	}
	const mappings = mappingsOf(served, version);
	const old = grantedMembers(versionAt(contract, version), granted);
	for (const member of old.state.keys()) {
		if (mappings?.state?.[member] === "refuse") return refused(contract, version, member);
	}
	for (const member of old.keyed.keys()) {
		if (mappings?.keyed?.[member] === "refuse") return refused(contract, version, member);
	}
	for (const member of old.events.keys()) {
		if (mappings?.events?.[member] === "refuse") return refused(contract, version, member);
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
	/** The event members mapped so far, each tapping the instance's node; made by the first. */
	#events: Map<string, MappedEvents> | undefined;

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

	/**
	 * Event member `member`'s node as this version's bindings tap it: the instance's own when unchanged since, a mapping
	 * node (made by the first use) when changed; `undefined` when this version is not accepted, or the instance lacks the
	 * member (removed since, or not granted: an older consumer receives none of it).
	 */
	event(member: string): EventNode | undefined {
		const instance = this.#instance;
		const { served } = instance;
		if (!served.provider.accepted.some(({ version }) => version === this.version)) return undefined;
		const node = instance.event(member);
		if (node === undefined) return undefined;
		const mapping = this.#mappings?.events?.[member];
		if (mapping === undefined) return node;
		// A refused member refused the binding (`refusal`): no binding of this version taps it.
		if (mapping === "refuse") return undefined;
		this.#events ??= new Map();
		let mapped = this.#events.get(member);
		if (mapped === undefined) {
			mapped = new MappedEvents(node, mapping, (error) => instance.reportEvent(member, error), instance.metrics);
			this.#events.set(member, mapped);
		}
		return mapped;
	}

	/** Its instance ended, or the version's last reference left: its derives go (their watches end with `error`). */
	detach(error: Error): void {
		for (const mapped of this.#events?.values() ?? []) mapped.detach();
		this.#events = undefined;
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
	 * member when the current version has it, else of the whole current state its caller was granted (a removed member).
	 */
	#make(member: string): DeriveSource {
		this.#assertAccepted();
		const instance = this.#instance;
		const { granted, batch } = instance;
		const mapping = this.#mappings?.state?.[member];
		if (mapping === undefined) return instance.member(member);
		if (mapping === "refuse") throw refused(this.#contract, this.version, member);
		const map = (value: unknown): JsonValue => {
			batch.count("chord.contract.adapts");
			// The provider's mapping, typed by its contract; its result is the old member's shape (not validated).
			return mapping(value as never) as JsonValue;
		};
		const version = currentVersion(this.#contract);
		const current = grantedMembers(version, granted);
		// The member when the current version has it, else the whole current state granted (a removed member); a
		// grantable one not granted is refused, never mapped as removed.
		const kept = current.state.has(member);
		if (!kept && version.grantable.has(member))
			throw lacking(this.#instance.label, this.#contract, member, "state member");
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

/**
 * An older version's event member: a node tapping the instance's (every entry), mapping each value once for all of
 * this version's bindings, delivered to them with its stamp and counter value. A mapping that throws drops that emit
 * for this version only (counted), reported once per failure episode, and is tried again at the next emit.
 */
class MappedEvents extends EventNode {
	readonly #source: EventNode;
	readonly #tap: Tap;
	#failing = false;

	constructor(
		source: EventNode,
		mapping: (current: never) => unknown,
		report: (error: unknown) => void,
		metrics: ChordMetrics,
	) {
		super();
		this.#source = source;
		const deliver = (entry: EventEntry, flush: EventFlush): void => {
			if (!this.tapped) return;
			let value: JsonValue;
			try {
				// The provider's mapping, typed by its contract; its result is the old shape (not validated).
				value = mapping(entry.value as never) as JsonValue;
			} catch (error) {
				metrics.counter("chord.events.dropped").add(1, { reason: "mapping" });
				if (!this.#failing) report(error);
				this.#failing = true;
				return;
			}
			this.#failing = false;
			this.deliver({ node: this, value, at: entry.at, n: entry.n, part: undefined }, flush);
		};
		// Every entry: its own bindings judge them by their counter values.
		this.#tap = { boundAt: Number.NEGATIVE_INFINITY, deliver };
		source.tap(this.#tap);
	}

	/** Its version's last binding left, or its instance ended: it maps nothing more. */
	detach(): void {
		this.#source.untap(this.#tap);
		this.clear();
	}
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
