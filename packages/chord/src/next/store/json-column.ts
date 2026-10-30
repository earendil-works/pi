// `json(schema, { version, migrate? })` table columns (decision "The `json(...)` column helper", W11): one JSON `TEXT`
// cell with its own version, typed when read, migrated on access (the result checked once, R8), never walked on write
// (R9).

import Type, { type TUnsafe } from "typebox";
import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Static, TSchema } from "../contracts/index.ts";
import { fingerprintOf } from "../contracts/internal.ts";
import { snapshotSchema } from "../contracts/snapshot.ts";
import { ChordError } from "../data/index.ts";
import { validatorFor } from "../data/internal.ts";

/** What `json(...)` takes besides the schema. */
export type JsonColumnOptions<T> = {
	/** The version of the cells' shape; a cell stores the version it was written at. */
	readonly version: number;
	/** Maps a cell of an older version `from` to this version's shape; pure. Without it older cells are refused. */
	readonly migrate?: (old: JsonValue, from: number) => T;
};

/** A `json(...)` column as `columns` takes it: a schema of the cells' type carrying the column. */
export type JsonColumnSchema<T> = TUnsafe<T> & { readonly json: JsonColumn };

/** A column holding one JSON value of `schema` per row, at `version`; wrap it in `opt(...)` to make it nullable. */
export function json<S extends TSchema>(schema: S, options: JsonColumnOptions<Static<S>>): JsonColumnSchema<Static<S>> {
	const column = new JsonColumn(schema, options.version, options.migrate);
	// A TypeBox schema (so `opt(...)` and `Static` take it) whose enumerable `json` field `opt`'s clone keeps.
	return Type.Unsafe<Static<S>>({ json: column }) as JsonColumnSchema<Static<S>>;
}

/** A `json(...)` column's definition: its schema snapshot, version and fingerprint, and the read of a stored cell. */
export class JsonColumn {
	readonly schema: TSchema;
	readonly version: number;
	/** The fingerprint of the schema's normal form, recorded with the table: the same version with another is `broken`. */
	readonly fingerprint: string;
	readonly #migrate: ((old: JsonValue, from: number) => unknown) | undefined;

	constructor(schema: TSchema, version: number, migrate: ((old: JsonValue, from: number) => unknown) | undefined) {
		// Declaration policy: JavaScript callers reach this check.
		if (!Number.isSafeInteger(version) || version < 1)
			throw new Error(`json(...): version ${version} is not a positive integer`);
		const snapshot = snapshotSchema(schema, "json(...)");
		this.schema = snapshot.schema;
		this.version = version;
		this.fingerprint = fingerprintOf(snapshot.normal);
		this.#migrate = migrate;
	}

	/**
	 * The value of a stored cell written at `version`: parsed; an older one migrated and checked once (R8, counted). A
	 * newer version, a missing or throwing `migrate` and an invalid result throw `unavailable` (`what` names the cell);
	 * the caller fails the owner (slice 6a §1.4), the data stays.
	 */
	read(text: string, version: number, what: string, context: Context): unknown {
		const value = JSON.parse(text) as JsonValue;
		if (version === this.version) return value;
		if (version > this.version) throw refused(`${what}: stored at version ${version}, newer than ${this.version}`);
		if (this.#migrate === undefined) throw refused(`${what}: no migrate from version ${version} to ${this.version}`);
		let migrated: unknown;
		try {
			migrated = this.#migrate(value, version);
		} catch (error) {
			throw refused(`${what}: migrate from version ${version} threw`, error);
		}
		context.telemetry.metrics?.counter("chord.data.validations").add(1);
		if (!validatorFor(this, context).Check(migrated)) {
			throw refused(`${what}: migrate from version ${version} does not match the schema`);
		}
		return migrated;
	}
}

/** The error of a cell the code cannot read: the owner fails `broken` with it. */
function refused(message: string, cause?: unknown): ChordError {
	return new ChordError({ code: "unavailable", message }, cause === undefined ? undefined : { cause });
}
