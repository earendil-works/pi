// ChordError: Chord's one error type, its codes and reasons (link protocol) and its wire form; and PluginError, what a
// plugin throws to give its callers a code of its own.

import type { JsonValue } from "../../json.ts";

/** Version of the error table below on links; adding or moving a code or reason bumps it. */
export const PROTOCOL_VERSION = 1;

/** Every code with the reasons it may carry. `invalid` requires a reason; every other code may omit it. */
export const CHORD_ERROR_REASONS = {
	invalid: ["args", "params", "member", "host_address", "reentrant", "read_after_bulk", "cycle"],
	contract_mismatch: ["updating"],
	forbidden: ["revoked"],
	gone: [],
	not_ready: [],
	// No reason: released by its holder. `ended`: its object ended; `closed`: its host, store or native closed;
	// `settled`: used after the call or run it belonged to settled; `version`: an old handle after a migration;
	// `discarded`: a transaction cut at the seal.
	released: ["ended", "closed", "settled", "version", "discarded"],
	too_large: ["part"],
	// `undeclared`: a registry no plugin serves on this host.
	unavailable: ["locked", "park_timeout", "busy", "storage_failed", "undeclared"],
	aborted: [],
} as const;

export type ChordErrorCode = keyof typeof CHORD_ERROR_REASONS;

export type ChordErrorReason<C extends ChordErrorCode = ChordErrorCode> = (typeof CHORD_ERROR_REASONS)[C][number];

/** The wire form of a ChordError and its constructor argument: one member per code, so wrong pairings fail to type. */
type ChordErrorJson = { [C in ChordErrorCode]: ErrorFields<C> }[ChordErrorCode];

type ErrorFields<C extends ChordErrorCode> = {
	readonly code: C;
	readonly message: string;
	readonly details?: JsonValue;
} & (C extends "invalid"
	? { readonly reason: ChordErrorReason<C> }
	: [ChordErrorReason<C>] extends [never]
		? { readonly reason?: undefined }
		: { readonly reason?: ChordErrorReason<C> });

class ChordErrorClass extends Error {
	readonly code: ChordErrorCode;
	readonly reason: ChordErrorReason | undefined;
	readonly details: JsonValue | undefined;

	constructor(init: ChordErrorJson, options?: ErrorOptions) {
		super(init.message, options);
		this.name = "ChordError";
		this.code = init.code;
		this.reason = init.reason;
		this.details = init.details;
	}

	/** The wire form; stack and cause never cross a link. */
	toJSON(): ChordErrorJson {
		const { code, reason, message, details } = this;
		// The fields were copied from a ChordErrorJson, so the pairing holds.
		return {
			code,
			...(reason === undefined ? {} : { reason }),
			message,
			...(details === undefined ? {} : { details }),
		} as ChordErrorJson;
	}
}

/** A Chord failure. Narrowing on `code` narrows `reason`. */
export type ChordError = ChordErrorClass & ChordErrorJson;

/**
 * Creates a ChordError: `new ChordError({ code: "invalid", reason: "args", message })`. A class cannot declare its
 * instances as a tagged union; this constructor signature does.
 */
export const ChordError = ChordErrorClass as new (init: ChordErrorJson, options?: ErrorOptions) => ChordError;

/** Whether `error` is a ChordError, optionally with the given code. */
export function isChordError<C extends ChordErrorCode = ChordErrorCode>(
	error: unknown,
	code?: C,
): error is Extract<ChordError, { readonly code: C }> {
	return error instanceof ChordError && (code === undefined || error.code === code);
}

/**
 * An error a plugin throws for its callers: its own `code`, a message and JSON `details`. Only these cross a link
 * (never a stack or a cause); a consumer rethrows it as a PluginError.
 */
export class PluginError extends Error {
	readonly code: string;
	readonly details: JsonValue | undefined;

	constructor(code: string, message: string, details?: JsonValue) {
		super(message);
		this.name = "PluginError";
		this.code = code;
		this.details = details;
	}
}

/** An `invalid` error with the given reason. */
export function invalid(
	reason: ChordErrorReason<"invalid">,
	message: string,
	details?: JsonValue,
): Extract<ChordError, { readonly code: "invalid" }> {
	// The constructor's return type cannot narrow on its argument.
	return new ChordError({ code: "invalid", reason, message, details }) as Extract<ChordError, { code: "invalid" }>;
}

/** `error` itself when it is a ChordError, otherwise an `unavailable` error naming `label`, with `error` as cause. */
export function asChordError(error: unknown, label: string): ChordError {
	if (isChordError(error)) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new ChordError({ code: "unavailable", message: `${label}: ${message}` }, { cause: error });
}

/**
 * Rebuilds a ChordError from a link. Checks the envelope only: a known code, a reason allowed for it (required for
 * `invalid`), a string message, no other keys. `details` is kept by reference.
 */
export function chordErrorFromJson(raw: unknown): ChordError {
	// Trust boundary: `raw` is fresh JSON from the link decoder.
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw envelopeError("not an object");
	const json = raw as Record<string, unknown>;
	for (const key of Object.keys(json)) if (!ENVELOPE_KEYS.has(key)) throw envelopeError(`unknown key "${key}"`);
	const { code, reason, message } = json;
	if (typeof code !== "string" || !Object.hasOwn(CHORD_ERROR_REASONS, code)) throw envelopeError("unknown code");
	const reasons: readonly string[] = CHORD_ERROR_REASONS[code as ChordErrorCode];
	if (reason === undefined ? code === "invalid" : !reasons.includes(reason as string)) {
		throw envelopeError(`reason not allowed for ${code}`);
	}
	if (typeof message !== "string") throw envelopeError("message is not a string");
	// The checks above establish the pairing.
	return new ChordError(json as ChordErrorJson);
}

const ENVELOPE_KEYS = new Set(["code", "reason", "message", "details"]);

function envelopeError(problem: string): Error {
	return new Error(`Invalid ChordError JSON: ${problem}`);
}
