/*--------------------------------------------------------------------------

TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---------------------------------------------------------------------------*/

// deno-fmt-ignore-file

import * as Pattern from "../pattern/pattern.ts";
import * as FormatPuny from "./puny.ts";

// ------------------------------------------------------------------
// LOCAL REGEX: Allowed Bidi classes per direction (RFC 5893)
// ------------------------------------------------------------------
const RE_RTL_ALLOWED = /^(?:R|AL|AN|EN|ES|CS|ET|ON|BN|NSM)$/;
const RE_LTR_ALLOWED = /^(?:L|EN|ES|CS|ET|ON|BN|NSM)$/;
const RE_RTL_CLASSES = /^(?:R|AL|AN)$/;

// ------------------------------------------------------------------
// HasBidiChars
//
// Decodes a punycode label to its Unicode form (if it is one) and
// checks whether the result is an RTL label per RFC 5893 §1.4.
// ------------------------------------------------------------------
export function HasBidiChars(value: string): boolean {
	if (FormatPuny.IsAcePrefixed(value)) {
		try {
			return HasRightToLeftCharacters(FormatPuny.Decode(value.slice(4).toLowerCase()));
		} catch {
			return false;
		}
	}
	return HasRightToLeftCharacters(value);
}
// ------------------------------------------------------------------
// GetBidiClass
// ------------------------------------------------------------------
function GetBidiClass(codePoint: number): string {
	const char = String.fromCodePoint(codePoint);
	return Pattern.RE_EUROPEAN_NUMBER.test(char)
		? "EN"
		: Pattern.RE_ARABIC_INDIC_DIGIT.test(char)
			? "AN"
			: // Pattern.RE_EUROPEAN_SEPARATOR.test(char) ? 'ES' : // (no-spec-coverage)
				// Pattern.RE_COMMON_SEPARATOR.test(char) ? 'CS' : // (no-spec-coverage)
				Pattern.RE_MARK_NONSPACING.test(char)
				? "NSM"
				: Pattern.RE_SCRIPT_HEBREW.test(char)
					? "R"
					: Pattern.RE_SCRIPT_ARABIC_LETTER.test(char)
						? "AL"
						: Pattern.RE_LETTER.test(char)
							? "L"
							: "ON";
}
// ------------------------------------------------------------------
// HasRightToLeftCharacters
//
// Per RFC 5893 §1.4: "An RTL label is a label that contains at least
// one character of type R, AL, or AN." Used to determine whether a
// domain name is a "Bidi domain name" (RFC 5893 §1.4), in which case
// the Bidi Rule applies to every label in the domain.
// ------------------------------------------------------------------
export function HasRightToLeftCharacters(value: string): boolean {
	for (const ch of value) if (RE_RTL_CLASSES.test(GetBidiClass(ch.codePointAt(0)!))) return true;
	return false;
}
// ------------------------------------------------------------------
// SatisfiesBidiRule
// ------------------------------------------------------------------
export function SatisfiesBidiRule(value: string): boolean {
	let isRtl = false;
	let allowed = RE_LTR_ALLOWED;
	let sawEN = false;
	let sawAN = false;
	let isFirst = true;
	// let lastClass: string | null = null // (no-spec-coverage)
	for (const ch of value) {
		const bidiClass = GetBidiClass(ch.codePointAt(0)!);
		if (isFirst) {
			// 1. The first character must be a character with Bidi property L, R, or AL.
			if (bidiClass !== "L" && bidiClass !== "R" && bidiClass !== "AL") return false;
			isRtl = bidiClass === "R" || bidiClass === "AL";
			allowed = isRtl ? RE_RTL_ALLOWED : RE_LTR_ALLOWED;
			isFirst = false;
		}
		// 2 / 5. Only characters in the allowed set for this direction may appear.
		if (!allowed.test(bidiClass)) return false;
		if (bidiClass === "EN") sawEN = true;
		else if (bidiClass === "AN") sawAN = true;
		// if (bidiClass !== 'NSM') lastClass = bidiClass // (no-spec-coverage)
	}
	if (isRtl && sawEN && sawAN) return false; // spec coverage path
	// (no-spec-coverage)
	// if (isRtl) {
	//   // 3. The end of the label must be R, AL, EN, or AN (ignoring trailing NSM).
	//   // if (lastClass !== 'R' && lastClass !== 'AL' && lastClass !== 'EN' && lastClass !== 'AN') return false
	//   // 4. If an EN is present, no AN may be present, and vice versa.
	//   if (sawEN && sawAN) return false
	// } else {
	//   // 6. The end of the label must be L or EN (ignoring trailing NSM).
	//   // if (lastClass !== 'L' && lastClass !== 'EN') return false
	// }
	return true;
}
