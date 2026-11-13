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

import * as FormatBidi from "../format/bidi.ts";
import * as FormatPuny from "../format/puny.ts";
import * as Pattern from "../pattern/pattern.ts";

// ------------------------------------------------------------------
// ExceedsMaxALabelLength
//
// RFC 5890 §2.3.2.1: an A-label (the ACE-encoded form of a label,
// "xn--" + punycode) must not exceed 63 octets. Only labels
// containing non-ASCII characters need checking - a pure-ASCII label
// has no "xn--" prefix and is used as-is, so its punycode-encoded
// length is irrelevant. The ASCII check is a cheap short-circuit that
// avoids running the punycode encoder on labels that don't need it.
// ------------------------------------------------------------------
function ExceedsMaxALabelLength(value: string): boolean {
	return Pattern.RE_NON_ASCII.test(value) && FormatPuny.Encode(value).length + 4 > 63;
}
// ------------------------------------------------------------------
// HasInvalidHyphens
//
// RFC 5891 §4.2.3.2: label must not start or end with a hyphen, and
// must not have hyphens in the 3rd and 4th codepoint positions (the
// ACE prefix reservation, e.g. "xn--"). Operates on `chars` (the
// per-codepoint string array) rather than raw string indices so
// supplementary-plane characters earlier in the label don't throw
// off the codepoint-position count.
// ------------------------------------------------------------------
function HasInvalidHyphens(chars: string[]): boolean {
	if (chars[0] === "-" || chars[chars.length - 1] === "-") return true;
	return chars.slice(2).join("").startsWith("--");
}
// ------------------------------------------------------------------
// IsUnicodeLabel
// ------------------------------------------------------------------
export function IsUnicodeLabel(value: string): boolean {
	// RFC 5890 §2.3.2.1: Ensure Max Length
	if (ExceedsMaxALabelLength(value)) return false;
	// RFC 5893 - Bidi Rule (applies whenever this label itself is RTL)
	if (FormatBidi.HasRightToLeftCharacters(value) && !FormatBidi.SatisfiesBidiRule(value)) return false;
	const chars = [...value];
	const codePoints = chars.map((c) => c.codePointAt(0)!);
	const length = codePoints.length;
	// RFC 5891 §4.2.3.2: Hyphen rules
	if (HasInvalidHyphens(chars)) return false;
	// RFC 5891 §4.2.3.2 - Must not begin with a combining mark
	if (Pattern.RE_COMBINING_MARK.test(chars[0])) return false;
	let hasJapanese = false;
	// let hasArabicIndic = false // (no-spec-coverage)
	// let hasExtendedArabicIndic = false // (no-spec-coverage)
	for (let i = 0; i < length; i++) {
		const codePoint = codePoints[i];
		const char = chars[i];
		// 1. DISALLOWED exceptions
		if (Pattern.RE_RFC5892_DISALLOWED.test(char)) return false;
		// 1b. General category (PVALID) enforcement
		if (!Pattern.RE_PERMITTED_CATEGORY.test(char)) return false;
		// 2. Collect Flags
		if (Pattern.RE_SCRIPT_JAPANESE.test(char)) hasJapanese = true;
		// if (Pattern.RE_ARABIC_INDIC_DIGIT.test(char)) hasArabicIndic = true  // (no-spec-coverage)
		// if (Pattern.RE_EXT_ARABIC_INDIC_DIGIT.test(char)) hasExtendedArabicIndic = true  // (no-spec-coverage)
		// 3. CONTEXTO / CONTEXTJ Neighbor Rules
		const prev = codePoints[i - 1],
			next = codePoints[i + 1];
		switch (codePoint) {
			case 0x00b7:
				if (prev !== 0x006c || next !== 0x006c) return false;
				break; // MIDDLE DOT (Catalan)
			case 0x0375:
				if (!next || !Pattern.RE_SCRIPT_GREEK.test(chars[i + 1])) return false;
				break; // Greek KERAIA
			case 0x05f3:
			case 0x05f4:
				if (!prev || !Pattern.RE_SCRIPT_HEBREW.test(chars[i - 1])) return false;
				break; // Hebrew GERESH
			case 0x200c: // ZWNJ - RFC 5892 Appendix A.1
				// Note: Full validation requires a Unicode joining type table. We reject
				// only when preceded by ASCII (U+0000-U+007F), which can never satisfy
				// the Virama or cursive-joining rules.
				if (!prev || (prev < 0x0080 && !Pattern.RE_VIRAMA.test(chars[i - 1]))) return false;
				break;
			case 0x200d: // ZWJ: RFC 5892 Appendix A.2
				if (!prev || !Pattern.RE_VIRAMA.test(chars[i - 1])) return false;
				break;
			case 0x30fb: // Checked at end via hasJapanese
				break; // KATAKANA MIDDLE DOT
		}
	}
	// 4. Global Context Validations (Post-loop)
	// RFC 5892 Appendix A.7 - Katakana Middle Dot requirement
	if (value.includes("\u30fb") && !hasJapanese) return false;
	// RFC 5892 Appendix A.8/A.9 - Mixing Arabic Digits
	// if (hasArabicIndic && hasExtendedArabicIndic) return false // (no-spec-coverage)
	return true;
}
