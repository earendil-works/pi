import type { Id, Seq } from "./types.ts";

/** Apply an erased ID brand at a trusted numeric allocation or decoding boundary. */
export function idFromNumber<I extends Id<string>>(value: number): I {
	return value as I;
}

/** Apply the erased commit-sequence brand at a trusted storage boundary. */
export function seqFromNumber(value: number): Seq {
	return value as Seq;
}
