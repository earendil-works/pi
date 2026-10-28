// A persisted run's record (slice 6b §4.1, D5): the document each unsettled run of a persisted job keeps in its
// object's store (namespace `chord.jobs`, kind the job name, key the run id), and the conversion of an outcome to and
// from it. Errors are stored in the wire error format, so a `PluginError`'s code, message and details survive.

import type { JsonValue } from "../../json.ts";
import type { JsonObject } from "../documents/index.ts";
import { errorFromWire, wireError } from "../link/internal.ts";
import type { WireError } from "../link/message.ts";
import type { JobError } from "./definition.ts";
import type { AnyOutcome, BlockedReason, JobRun, Phase } from "./run.ts";

/** How a run failed, as stored: a thrown error in the wire format, an abort, the restart limit. */
export type StoredJobError =
	| { readonly kind: "threw"; readonly error: WireError }
	| { readonly kind: "aborted"; readonly reason: "abort" | "reload" | "restart" }
	| { readonly kind: "restart_limit"; readonly restarts: number };

/** A run's outcome as stored: its result, or how it failed. */
export type StoredOutcome =
	| { readonly kind: "done"; readonly result: JsonValue }
	| { readonly kind: "failed"; readonly error: StoredJobError };

/** The record document of one unsettled persisted run. */
export type StoredRun = {
	readonly version: number;
	readonly fingerprint: string;
	readonly args: JsonValue;
	readonly key?: string;
	readonly trace?: { readonly [key: string]: string };
	readonly phase: Phase;
	readonly restarts: number;
	readonly finishFailures: number;
	readonly abort?: true;
	readonly blocked?: BlockedReason;
	readonly outcome?: StoredOutcome;
};

/**
 * The record documents' version and fingerprint (Chord's own documents: no definition, no `migrate`; a new record
 * shape raises the version).
 */
export const RUN_RECORD = { version: 1, fingerprint: "chord.job-run.1" } as const;

/** What a change sets on a run's record; the rest is the run's own. */
export type StoredFields = {
	readonly phase?: Phase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
	readonly blocked?: BlockedReason;
	readonly outcome?: AnyOutcome;
};

/** `run`'s record as stored with `fields` changed, with the job's `fingerprint`. */
export function storedRun(run: JobRun, fingerprint: string, fields: StoredFields = {}): StoredRun {
	const { version, args, key, trace } = run;
	const { phase, restarts, finishFailures, abortMarked, blocked, outcome } = { ...pick(run), ...fields };
	return {
		version,
		fingerprint,
		args,
		...(key === undefined ? {} : { key }),
		...(trace === undefined ? {} : { trace }),
		phase,
		restarts,
		finishFailures,
		...(abortMarked ? { abort: true as const } : {}),
		...(blocked === undefined ? {} : { blocked }),
		...(outcome === undefined ? {} : { outcome: storedOutcome(outcome) }),
	};
}

/** The fields of `run` a record stores that change. */
function pick(run: JobRun): Required<Omit<StoredFields, "blocked" | "outcome" | "abortMarked">> & StoredFields {
	const { phase, restarts, finishFailures, blocked, outcome } = run;
	return { phase, restarts, finishFailures, ...(run.abortMarked ? { abortMarked: true } : {}), blocked, outcome };
}

/** An outcome as stored: a result as it is (JSON: persisted jobs refuse `bytes()`), an error in the wire format. */
function storedOutcome(outcome: AnyOutcome): StoredOutcome {
	if (outcome.kind === "done") return { kind: "done", result: outcome.result as JsonValue };
	return { kind: "failed", error: storedError(outcome.error) };
}

function storedError(error: JobError): StoredJobError {
	return error.kind === "threw" ? { kind: "threw", error: wireError(error.error) } : error;
}

/** The outcome a stored one stands for, rebuilt as the in-memory one (`id`, `args` and `state` from the run). */
export function outcomeOf(
	stored: StoredOutcome,
	id: string,
	args: JsonValue,
	state: JsonValue | undefined,
): AnyOutcome {
	if (stored.kind === "done") return { id, args, state, kind: "done", result: stored.result };
	const { error } = stored;
	const rebuilt: JobError = error.kind === "threw" ? { kind: "threw", error: errorFromWire(error.error) } : error;
	return { id, args, state, kind: "failed", error: rebuilt };
}

/** A stored record as Chord wrote it (the record definition's value, a JSON object). */
export function recordOf(value: JsonObject): StoredRun {
	// Chord's own document: `storedRun` wrote it.
	return value as unknown as StoredRun;
}
