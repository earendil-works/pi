// A refused commit as Chord's owners take it (slice 6b D4, §1.4): the store rejects a step it rolled back with the
// step's own error, unchanged (Durable's Storage semantics); Chord classifies it: an `int` column's `CHECK` (a
// plugin's value out of range) fails only its transaction, any other refusal means memory and disk disagree.

import { ChordError, isChordError } from "../data/index.ts";

/** How a Chord commit ended that the store rejected: `check` fails the transaction only, `broken` its object too. */
export type Refusal =
	| { readonly kind: "check"; readonly error: ChordError }
	| { readonly kind: "broken"; readonly error: ChordError };

/** SQLite's extended result code `SQLITE_CONSTRAINT_CHECK`, which Node's binding reports as `errcode`. */
const SQLITE_CONSTRAINT_CHECK = 275;

/**
 * The refusal behind `error`, a store commit's rejection; `undefined` when it is the store's own (`released` at
 * admission or after close, `unavailable/storage_failed` once stopped), which the owner rethrows as it is.
 */
export function refusalOf(error: unknown, label: string): Refusal | undefined {
	if (isChordError(error, "released") || (isChordError(error, "unavailable") && error.reason === "storage_failed")) {
		return undefined;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (isCheck(error, message)) {
		const refused = `${label}: a value is out of its column's range (${message})`;
		return {
			kind: "check",
			error: new ChordError({ code: "invalid", reason: "args", message: refused }, { cause: error }),
		};
	}
	const refused = `${label}: the store refused the commit (${message})`;
	return { kind: "broken", error: new ChordError({ code: "unavailable", message: refused }, { cause: error }) };
}

/**
 * Whether a refusal is a `CHECK` failure: SQLite's extended code where the binding has one (Node), the message
 * otherwise (the Durable Object facade has no extended codes).
 */
function isCheck(error: unknown, message: string): boolean {
	const code = (error as { readonly errcode?: unknown } | undefined)?.errcode;
	if (typeof code === "number") return code === SQLITE_CONSTRAINT_CHECK;
	return message.includes("CHECK constraint failed");
}
