// Job definitions (§15): `defineJob(name, …)`, the checks of a declaration, and the types of what a run ends with.

import { checkKeys, entriesOf } from "../contracts/declare.ts";
import type { Static, TSchema } from "../contracts/index.ts";
import { checkName, hash64 } from "../contracts/internal.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "../contracts/snapshot.ts";
import type { ChordError, PluginError } from "../data/index.ts";
import type { JsonObject, StateDefinition } from "../documents/index.ts";

/** What `defineJob` takes besides the name. */
export type JobOptions<
	A extends TSchema,
	R extends TSchema,
	D extends StateDefinition<JsonObject, false, boolean> | undefined,
> = {
	/** The job's version; every change of its args, result or state bumps it. */
	readonly version: number;
	/** The run's arguments: closed objects, JSON only (`running` carries them), checked at every start. */
	readonly args: A;
	/** What `run` returns; not validated. */
	readonly result: R;
	/**
	 * A singleton document definition: one document per run, `ctx.state` in `run`, `outcome.state` in `finish`; a
	 * persisted job's is persisted (`persist: true`, its `checkpointWhen`).
	 */
	readonly state?: D;
	/** At most this many runs running or finishing per object; a start beyond it rejects `unavailable/busy`. */
	readonly concurrency?: number;
	/** Per older version, how its args and result map forwards (used from slice 7 on; checked now). */
	readonly accepts?: JobAccepts<A, R>;
	/**
	 * Persists the runs in the object's store (slice 6b; only in `local` types with empty params, P3): how a run cut
	 * off by a crash or a stop resumes, `rerun` (its `run` again: idempotent work) or `abandon` (`finish` gets `failed {
	 * aborted, reason: "restart" }`). Its result is JSON only (no `bytes()`).
	 */
	readonly persist?: JobPersistence;
};

/** How a persisted job's runs resume after a crash or a stop. */
export type JobPersistence = { readonly resume: "rerun" | "abandon" };

/** Per older version, its mappings forwards: its args to the current args, its result to the current result. */
export type JobAccepts<A extends TSchema = TSchema, R extends TSchema = TSchema> = {
	readonly [version: number]: { readonly args: (old: never) => Static<A>; readonly result: (old: never) => Static<R> };
};

/** The value of a job's state document: the definition's document, `undefined` without one. */
type StateOf<D> = D extends StateDefinition<infer T, false, boolean> ? T : undefined;

/** What a run ended with, as `finish` and `outcome` get it: its args and state, and its result or its error. */
export type Outcome<A, R, S> = { readonly id: string; readonly args: A; readonly state: S } & (
	| { readonly kind: "done"; readonly result: R }
	| { readonly kind: "failed"; readonly error: JobError }
);

/**
 * Why a run failed: `run` threw (reported as `job_failed`; anything but a ChordError or PluginError becomes a
 * PluginError `internal` with its message), it was aborted (`abort`: `abort(id)`; `restart`: cut off by its attempt's
 * seal while the object continues, or a persisted run abandoned after a crash; `reload` comes with slice 7), or a
 * persisted run was cut off five times in a row (`restart_limit`, D6).
 */
export type JobError =
	| { readonly kind: "threw"; readonly error: ChordError | PluginError }
	| { readonly kind: "aborted"; readonly reason: "abort" | "reload" | "restart" }
	| { readonly kind: "restart_limit"; readonly restarts: number };

/** Declares a job: owned work a call starts that outlives it (§15). */
export function defineJob<
	const A extends TSchema,
	const R extends TSchema,
	D extends StateDefinition<JsonObject, false, boolean> | undefined = undefined,
>(name: string, options: JobOptions<A, R, D>): JobDefinition<Static<A>, Static<R>, StateOf<D>> {
	// Declaration policy: JavaScript callers reach every check below.
	checkName(name, "A job name");
	checkKeys(options, ["version", "args", "result", "state", "concurrency", "accepts", "persist"], name);
	const { version, state, concurrency, accepts, persist } = options;
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	const args = snapshotArguments(options.args, `${name}.args`);
	if (args.bytes) throw new Error(`${name}.args: job arguments are JSON (running carries them); no bytes()`);
	const result = snapshotSchema(options.result, `${name}.result`);
	if (state?.keyed) throw new Error(`${name}.state: expected a singleton document definition`);
	if (persist !== undefined) checkPersistence(persist, state, result, name);
	if (concurrency !== undefined && !(Number.isSafeInteger(concurrency) && concurrency > 0)) {
		throw new Error(`${name}.concurrency: expected a positive integer`);
	}
	if (accepts !== undefined) checkJobAccepts(accepts, version, `${name}.accepts`);
	const fingerprint = hash64(
		JSON.stringify({ args: args.normal, result: result.normal, state: state?.fingerprint ?? null }),
	);
	return new JobDefinition(name, version, args, result, state, concurrency, accepts ?? {}, persist, fingerprint);
}

/** A persisted job's declaration: a resume rule, a persisted state document (if any), a JSON-only result. */
function checkPersistence(
	persist: unknown,
	state: StateDefinition<JsonObject, false, boolean> | undefined,
	result: Snapshot,
	name: string,
): void {
	checkKeys(persist, ["resume"], `${name}.persist`);
	const { resume } = persist as { readonly resume?: unknown };
	if (resume !== "rerun" && resume !== "abandon")
		throw new Error(`${name}.persist.resume: expected "rerun" or "abandon"`);
	if (state !== undefined && !state.persist) {
		throw new Error(`${name}.state: a persisted job's state is a persisted document (persist: true)`);
	}
	if (result.bytes) throw new Error(`${name}.result: a persisted job's result is JSON (it is stored); no bytes()`);
}

/** Checks an accepts table's shape: older versions only, each with an `args` and a `result` function. */
function checkJobAccepts(accepts: unknown, version: number, path: string): void {
	for (const [key, adapter] of entriesOf(accepts, path)) {
		const older = Number(key);
		if (!Number.isSafeInteger(older) || older < 1 || older >= version) {
			throw new Error(`${path}[${key}]: not an older version`);
		}
		checkKeys(adapter, ["args", "result"], `${path}[${key}]`);
		const { args, result } = adapter as { readonly args?: unknown; readonly result?: unknown };
		if (typeof args !== "function") throw new Error(`${path}[${key}].args: expected a function`);
		if (typeof result !== "function") throw new Error(`${path}[${key}].result: expected a function`);
	}
}

/** A declared job; `A`, `R` and `S` are its args, result and state document (`undefined` without one). */
export class JobDefinition<A, R, S> {
	readonly name: string;
	readonly version: number;
	/** The args schema, Chord's copy; its compiled check is cached by this snapshot. */
	readonly args: Snapshot;
	readonly result: Snapshot;
	readonly state: StateDefinition<JsonObject, false, boolean> | undefined;
	readonly concurrency: number | undefined;
	/** The older versions' mappings, checked at declaration; slice 7 maps older runs with them. */
	readonly accepts: JobAccepts;
	/** How its runs persist; `undefined` for a job in memory. */
	readonly persist: JobPersistence | undefined;
	/** `hash64` of its args', result's and state's normal forms: a stored run of another fingerprint is blocked. */
	readonly fingerprint: string;
	/** Type only: the args, result and state types. */
	declare readonly "~types"?: { readonly args: A; readonly result: R; readonly state: S };

	constructor(
		name: string,
		version: number,
		args: Snapshot,
		result: Snapshot,
		state: StateDefinition<JsonObject, false, boolean> | undefined,
		concurrency: number | undefined,
		accepts: JobAccepts,
		persist: JobPersistence | undefined,
		fingerprint: string,
	) {
		this.name = name;
		this.version = version;
		this.args = args;
		this.result = result;
		this.state = state;
		this.concurrency = concurrency;
		this.accepts = accepts;
		this.persist = persist;
		this.fingerprint = fingerprint;
	}
}
