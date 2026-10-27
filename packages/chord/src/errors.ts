/** Error codes callers see (guide table). A refused or aborted reload keeps the code of its cause. */
export const CHORD_ERROR_CODES = [
	"aborted",
	"contract_mismatch",
	"forbidden",
	"gone",
	"invalid",
	"not_in_variant",
	"not_ready",
	"released",
	"superseded",
	"unavailable",
	"upgrade_conflict",
	"upgrade_required",
] as const;
export type ChordErrorCode = (typeof CHORD_ERROR_CODES)[number];

/**
 * Finer cause inside a code, for logs and tests: e.g. `invalid` + `args`, `result`, `state`, `input`, `implementation`,
 * `duplicate`, `cycle`, `read_only`, `not_host_lifetime`, `registry_conflict`; `unavailable` + `unknown_type`.
 */
export type ChordErrorReason = string;

const RETRYABLE: ReadonlySet<ChordErrorCode> = new Set(["superseded", "upgrade_conflict"]);

export class ChordError extends Error {
	readonly code: ChordErrorCode;
	readonly reason: ChordErrorReason | undefined;
	readonly retryable: boolean;
	readonly details: unknown;
	constructor(
		code: ChordErrorCode,
		message: string,
		options?: { cause?: unknown; details?: unknown; reason?: ChordErrorReason },
	) {
		super(`${code}${options?.reason ? `/${options.reason}` : ""}: ${message}`, {
			cause: options?.cause,
		});
		this.name = "ChordError";
		this.code = code;
		this.reason = options?.reason;
		this.retryable = RETRYABLE.has(code);
		this.details = options?.details;
	}
}

export const isChordError = (error: unknown, code?: ChordErrorCode): error is ChordError =>
	error instanceof ChordError && (code === undefined || error.code === code);

/** For factories and methods refusing a principal: `throw forbidden()`. */
export const forbidden = (message = "forbidden"): ChordError => new ChordError("forbidden", message);

export const invalid = (reason: ChordErrorReason, message: string, details?: unknown): ChordError =>
	new ChordError("invalid", message, { reason, details });

/** Keeps a ChordError's code; anything else becomes `unavailable` with the original as cause. */
export const asChordError = (error: unknown, context: string): ChordError =>
	error instanceof ChordError
		? error
		: new ChordError("unavailable", `${context}: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});

/** Runs every step, then throws one error, or an AggregateError when several failed. */
export async function runAll(steps: readonly (() => unknown)[], message: string): Promise<void> {
	const errors: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}
