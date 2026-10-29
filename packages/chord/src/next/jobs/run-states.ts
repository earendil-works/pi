// A job's run state documents (§15, slice 6b §4.1, §4.3): one per run by its id, Chord's own slot apart from the
// object's `self.state` slots. In memory, or persisted in the object's store (namespace `chord.job-states`), always in
// memory while the run is unsettled (`ctx.state.value` reads it synchronously). A persisted run's deferred changes
// (D8) are adopted and published at once and held, stored before the next change's own, at the outcome, at close or
// when their deadline passes.

import type { Context } from "../../context/index.ts";
import { type Op, PendingOps, type Prepared, type Tracker, track } from "../../delta/index.ts";
import { ChordError } from "../data/index.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "../documents/index.ts";
import {
	type DocumentChange,
	type DocumentSlot,
	type Documents,
	type Held,
	type PersistedSlot,
	type Persistence,
	SlotDefinition,
	type Stored,
	type StoredChange,
	storedAfter,
} from "../documents/internal.ts";
import { changeDocument, createDocument } from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";

/**
 * A held state's ops, folded as they come (`PendingOps`: repeated writes of one leaf keep one op; past its bound only
 * "store a base" stays), whether a held change asked for a base, and when it must be stored at the latest.
 */
type HeldState = { readonly pending: PendingOps; base: boolean; deadline: number };

/** What the run states tell their job: a document changed (`running` follows), a held change's deadline. */
export type RunStatesOwner = {
	readonly documents: Documents;
	/** Run `id`'s document changed by `ops`, inside the commit step. */
	changed(id: string, ops: readonly Op[]): void;
	/** A held change must be stored by `deadline` (`Date.now()` time). */
	held(deadline: number): void;
};

/** How long a deferred change is held at most by default (Durable's `progress.persistWithinMs`). */
const DEFAULT_WITHIN_MS = 1_000;

/** A run's state documents. Created with the run, retired with its record; never drafted while absent. */
export class RunStates implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	/** The store side when the job persists; `undefined` in memory. */
	readonly persisted: PersistedSlot | undefined;
	readonly definition: SlotDefinition;
	readonly #persistence: Persistence | undefined;
	readonly #states: RunStatesOwner;
	readonly #trackers = new Map<string, Tracker<JsonObject>>();
	readonly #stored = new Map<string, Stored>();
	readonly #held = new Map<string, HeldState>();

	constructor(
		definition: StateDefinition<JsonObject, false, boolean>,
		states: RunStatesOwner,
		persistence: Persistence | undefined,
	) {
		this.definition = new SlotDefinition(definition);
		this.owner = states.documents;
		this.#states = states;
		this.#persistence = persistence;
		this.persisted = persistence === undefined ? undefined : this;
	}

	get persistence(): Persistence {
		// Only reached through `persisted`, which a persisted job's states alone have.
		return this.#persistence!;
	}

	/** The value of run `id`'s document; `undefined` once retired. */
	value(id: string): JsonObject | undefined {
		return this.#trackers.get(id)?.value;
	}

	current(key: string): Tracker<JsonObject> | undefined {
		return this.#trackers.get(key);
	}

	initial(_context: Context): JsonObject {
		throw new ChordError({
			code: "released",
			reason: "settled",
			message: `${this.definition.current.name}: the run's document is retired`,
		});
	}

	/** Pinned in memory while the run is unsettled: never cold. */
	cold(_key: string): boolean {
		return false;
	}

	stored(key: string): Stored | undefined {
		return this.#stored.get(key);
	}

	async load(_key: string, _context: Context): Promise<void> {}

	/**
	 * A change of run `key`'s document: a deferred one of a stored document is held (nothing written); an immediate
	 * one stores what is held with its own ops, as one delta on the stored revision or a base.
	 */
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
		persistence: CommitPersistence,
	): StoredChange {
		if (persistence.kind === "deferred" && was !== undefined && !change.retires && change.prepared !== undefined) {
			return { kind: "held", stored: was, withinMs: persistence.withinMs ?? DEFAULT_WITHIN_MS };
		}
		const held = this.#held.get(key);
		return this.persistence.stage(key, this.definition.current, was, change, writes, held && heldOps(held));
	}

	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		change: StoredChange | undefined,
	): void {
		tracker.adopt(prepared);
		if (change?.kind === "held") this.#hold(key, prepared, change);
		else if (change !== undefined) this.#settle(key, storedAfter(change));
		this.#states.changed(key, prepared.ops);
	}

	/** Retires run `key`'s document (its record's deletion): what is held goes with it. */
	retire(key: string): void {
		this.#trackers.delete(key);
		this.#stored.delete(key);
		this.#held.delete(key);
	}

	/** Run `id`'s document with `value`, as its start created it or a load found it (`stored`: persisted). */
	create(id: string, value: JsonObject, stored: Stored | undefined): void {
		this.#trackers.set(id, track(value));
		if (stored !== undefined) this.#stored.set(id, stored);
	}

	/**
	 * Stages the creation of run `id`'s document with `value` into `writes` (its start); returns the adoption, which
	 * creates it in memory with what is stored.
	 */
	stageCreate(id: string, value: JsonObject, writes: () => StagedWrite[]): () => void {
		const persistence = this.#persistence;
		if (persistence === undefined) return () => this.create(id, value, undefined);
		const { version, fingerprint } = this.definition.current;
		const created = { id: 0 };
		const base = { version, fingerprint, value };
		writes().push(
			createDocument(persistence.at(id), base, JSON.stringify(value), (stored) => {
				created.id = stored;
			}),
		);
		return () => this.create(id, value, { id: created.id, revision: 1, version, deltasSinceBase: 0 });
	}

	/** When run `id`'s held changes must be stored at the latest (`Infinity`: none held, or none with a deadline). */
	deadline(id: string): number {
		return this.#held.get(id)?.deadline ?? Number.POSITIVE_INFINITY;
	}

	/** The runs whose documents hold changes not stored yet. */
	get heldIds(): readonly string[] {
		return [...this.#held.keys()];
	}

	/**
	 * Stages what run `id`'s document holds into `writes` (a flush: its deadline, the outcome, the close writer), as one
	 * delta on its stored revision or a base; returns the adoption, `undefined` when nothing is held.
	 */
	stageHeld(id: string, writes: StagedWrite[]): (() => void) | undefined {
		const held = this.#held.get(id);
		const stored = this.#stored.get(id);
		const tracker = this.#trackers.get(id);
		if (held === undefined || stored === undefined || tracker === undefined) return undefined;
		const { version, fingerprint } = this.definition.current;
		const value = tracker.value;
		const { ops, base: asked } = heldOps(held);
		const base = asked || stored.version !== version;
		const content = base
			? ({ kind: "base", version, fingerprint, value } as const)
			: ({ kind: "delta", version, ops } as const);
		writes.push(changeDocument(stored.id, stored.revision, content, JSON.stringify(base ? value : ops)));
		const deltasSinceBase = base ? 0 : stored.deltasSinceBase + 1;
		const after: Stored = { id: stored.id, revision: stored.revision + 1, version, deltasSinceBase };
		return () => {
			if (this.#held.get(id) === held) this.#settle(id, after);
		};
	}

	/** Drops every document (the object ended): what is held is lost, as a crash loses it. */
	drop(): void {
		this.#trackers.clear();
		this.#stored.clear();
		this.#held.clear();
	}

	/** What is stored of run `key`'s document after a commit stored it: nothing is held any more. */
	#settle(key: string, stored: Stored | undefined): void {
		if (stored === undefined) this.#stored.delete(key);
		else this.#stored.set(key, stored);
		this.#held.delete(key);
	}

	/** A deferred change adopted: its ops held (a base when `checkpointWhen` asks), its deadline told. */
	#hold(key: string, prepared: Prepared<JsonObject>, change: Extract<StoredChange, { kind: "held" }>): void {
		const held = this.#held.get(key) ?? {
			pending: new PendingOps(),
			base: false,
			deadline: Number.POSITIVE_INFINITY,
		};
		const deltasSinceBase = change.stored.deltasSinceBase + (held.pending.size > 0 ? 1 : 0);
		if (this.definition.current.checkpointWhen(prepared.value, prepared.ops, { deltasSinceBase })) held.base = true;
		// A base stores the whole value: no op needs keeping for it.
		if (held.base) held.pending.take();
		else held.pending.push(prepared.ops);
		held.deadline = Math.min(held.deadline, Date.now() + change.withinMs);
		this.#held.set(key, held);
		if (Number.isFinite(held.deadline)) this.#states.held(held.deadline);
	}
}

/**
 * What `held` stores, its queue left as it was (a commit may still be refused): its folded ops, or a base once a held
 * change asked for one or the queue overflowed. Taking and pushing back one batch keeps it by reference: no copy.
 */
function heldOps(held: HeldState): Held {
	if (held.base) return NO_HELD_OPS_BASE;
	const taken = held.pending.take();
	if (taken.kind === "replace") {
		held.base = true;
		return NO_HELD_OPS_BASE;
	}
	held.pending.push(taken.ops);
	return { ops: taken.ops, base: false };
}

const NO_HELD_OPS_BASE: Held = { ops: [], base: true };
