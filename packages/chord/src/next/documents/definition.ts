// Document definitions: `defineState(name, ...)`, its fingerprint, the one check of a definition's `initial()` (R8),
// the checked `migrate` of an older value and, for a persisted document, its checkpoint rule (slice 6a §10).

import type { Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Static, TSchema } from "../contracts/index.ts";
import { checkName, fingerprintOf } from "../contracts/internal.ts";
import { snapshotSchema } from "../contracts/snapshot.ts";
import { validatorFor } from "../data/internal.ts";

/** A document root: a JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * When a commit reaches the store (Durable's `CommitPersistence`): `immediate`, the default, before the commit
 * resolves; `deferred` (a persisted run's state change, D8): adopted and published at once, stored with the next
 * immediate change, the run's outcome, the object's close, or about `withinMs` (default 1,000 ms) later.
 */
export type CommitPersistence =
	| { readonly kind: "immediate" }
	| { readonly kind: "deferred"; readonly withinMs?: number };

/** What a persisted document's `checkpointWhen` learns of its stored revisions. */
export type CheckpointInfo = {
	/** The deltas stored after its newest base, without the change being decided. */
	readonly deltasSinceBase: number;
};

/** Whether a commit's change of a persisted document is stored as a whole new base (`true`) or as a delta. */
export type CheckpointWhen<T> = (value: T, ops: readonly Op[], info: CheckpointInfo) => boolean;

/** What `defineState` takes for any document. */
type StateOptions<S extends TSchema, K extends boolean> = {
	readonly schema: S;
	readonly version: number;
	readonly initial: () => DocumentOf<S>;
	/** Maps a value of an older version `from` to this version's shape; pure. Required to read older values. */
	readonly migrate?: (old: JsonObject, from: number) => DocumentOf<S>;
	readonly keyed?: K;
};

/** What a persisted document adds (slice 6a §10): `checkpointWhen` is required. */
type PersistOptions<S extends TSchema> = {
	/** Stored in the host's store; only in `local` types with empty params (P3). */
	readonly persist: true;
	/** Called once per commit per changed document; creations and version changes always store a base. */
	readonly checkpointWhen: CheckpointWhen<DocumentOf<S>>;
};

/**
 * Declares a document: a singleton per object, or with `keyed: true` many per object, each by a string key; with
 * `persist: true` stored in the host's store. Its name is a restricted name (lowercase `[a-z0-9@/._~-]`).
 */
export function defineState<S extends TSchema, K extends boolean = false>(
	name: string,
	options: StateOptions<S, K> & { readonly persist?: false; readonly checkpointWhen?: never },
): StateDefinition<DocumentOf<S>, K, false>;
export function defineState<S extends TSchema, K extends boolean = false>(
	name: string,
	options: StateOptions<S, K> & PersistOptions<S>,
): StateDefinition<DocumentOf<S>, K, true>;
export function defineState<S extends TSchema, K extends boolean>(
	name: string,
	options: StateOptions<S, K> & {
		readonly persist?: boolean;
		readonly checkpointWhen?: CheckpointWhen<DocumentOf<S>>;
	},
): StateDefinition<DocumentOf<S>, K, boolean> {
	checkName(name, "A state name");
	const { schema, version, initial, migrate, keyed, persist, checkpointWhen } = options;
	return new StateDefinition(
		name,
		schema,
		version,
		initial,
		migrate,
		keyed ?? false,
		persist ?? false,
		checkpointWhen,
	);
}

/** The value of a document whose schema is `S`: its static type, which must be a JSON object. */
type DocumentOf<S extends TSchema> = Static<S> extends JsonObject ? Static<S> : never;

const NEVER: CheckpointWhen<JsonObject> = () => false;

/** A declared document; `T` is its value, `K` whether it is keyed, `P` whether it is persisted. */
export class StateDefinition<T extends JsonObject, K extends boolean, P extends boolean = false> {
	readonly name: string;
	readonly schema: TSchema;
	readonly version: number;
	readonly keyed: boolean;
	readonly persist: boolean;
	/**
	 * `hash64` of the schema's normal form (descriptions and titles ignored), computed once: the same version with
	 * another fingerprint is a schema changed without a version bump.
	 */
	readonly fingerprint: string;
	/** Type only: whether the definition is keyed. */
	declare readonly "~keyed"?: K;
	/** Type only: whether the definition is persisted. */
	declare readonly "~persist"?: P;
	readonly #initial: () => T;
	readonly #migrate: ((old: JsonObject, from: number) => T) | undefined;
	/** Method-typed so that a definition of a narrower `T` still is a `StateDefinition<JsonObject, ...>`. */
	readonly #checkpointWhen: { rule(value: T, ops: readonly Op[], info: CheckpointInfo): boolean }["rule"];
	#checked = false;

	constructor(
		name: string,
		schema: TSchema,
		version: number,
		initial: () => T,
		migrate: ((old: JsonObject, from: number) => T) | undefined,
		keyed: boolean,
		persist: boolean,
		checkpointWhen: CheckpointWhen<T> | undefined,
	) {
		this.name = name;
		this.schema = schema;
		this.version = version;
		this.#initial = initial;
		this.#migrate = migrate;
		this.keyed = keyed;
		this.persist = persist;
		this.#checkpointWhen = checkpointWhen ?? NEVER;
		this.fingerprint = fingerprintOf(snapshotSchema(schema, name).normal);
	}

	/** Whether a persisted document's change is stored as a new base (its `checkpointWhen`); never asked in memory. */
	checkpointWhen(value: T, ops: readonly Op[], info: CheckpointInfo): boolean {
		return this.#checkpointWhen(value, ops, info);
	}

	/** A fresh `initial()` value; the first is checked against the schema (counted), later ones are not (R8). */
	initial(context: Context): T {
		const value = this.#initial();
		if (this.#checked) return value;
		this.#check(value, "initial()", context);
		this.#checked = true;
		return value;
	}

	/**
	 * `old`, a value of version `from`, migrated to this version and checked against the schema once, as it is
	 * produced (R8, counted). Throws without a `migrate` (the access is refused, the data kept) and when the result does
	 * not match.
	 */
	migrate(old: JsonObject, from: number, context: Context): T {
		if (this.#migrate === undefined) {
			throw new Error(`${this.name}: no migrate from version ${from} to ${this.version}`);
		}
		const value = this.#migrate(old, from);
		this.#check(value, `migrate() from version ${from}`, context);
		return value;
	}

	#check(value: T, what: string, context: Context): void {
		context.telemetry.metrics?.counter("chord.data.validations").add(1);
		if (!validatorFor(this, context).Check(value)) {
			throw new Error(`${this.name}: ${what} does not match the schema`);
		}
	}
}
