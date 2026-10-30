// Text in the store (decision "Text is plain UTF-8, in code point order"): Chord compares strings by code point, as
// SQLite's BINARY collation compares their UTF-8 bytes, never by JavaScript's UTF-16 code units; every stored string
// is well-formed and free of NUL, and a prefix becomes a range by its upper bound.

import { invalid } from "../data/internal.ts";

/** Compares `a` and `b` by code point: negative, zero or positive. */
export function compareText(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return codePointRank(x) - codePointRank(y);
	}
	return a.length - b.length;
}

/**
 * A UTF-16 code unit's rank in code point order: a surrogate starts a code point above U+FFFF, so it ranks above every
 * unit from U+E000 on.
 */
function codePointRank(unit: number): number {
	if (unit < 0xd800) return unit;
	return unit < 0xe000 ? unit + 0x2000 : unit - 0x800;
}

/**
 * `text` as the store keeps it: a lone surrogate replaced by U+FFFD (copied only when one occurs), NUL refused
 * `invalid/args` (`what` names the value). Plugin strings are a trust boundary.
 */
export function storedText(text: string, what: string): string {
	if (text.includes("\0")) throw invalid("args", `${what}: text may not contain NUL`);
	return text.isWellFormed() ? text : text.toWellFormed();
}

/**
 * The smallest string above every string starting with `prefix`, in code point order: the next code point after its
 * last, carrying past U+10FFFF; `undefined` when there is none (`""` and all-U+10FFFF prefixes). `prefix` is
 * well-formed.
 */
export function prefixUpperBound(prefix: string): string | undefined {
	const points = [...prefix];
	while (points.length > 0) {
		const last = points.pop()!.codePointAt(0)!;
		if (last === 0x10ffff) continue;
		// The surrogates are no code points of well-formed text: after U+D7FF comes U+E000.
		const next = last === 0xd7ff ? 0xe000 : last + 1;
		return points.join("") + String.fromCodePoint(next);
	}
	return undefined;
}
