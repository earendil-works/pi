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

import * as FormatBidi from "./format/bidi.ts";
import * as LabelPuny from "./label/puny.ts";
import * as LabelUnicode from "./label/unicode.ts";

// ------------------------------------------------------------------
// IsLabel
// ------------------------------------------------------------------
function IsValidLabelLength(value: string): boolean {
	return value.length > 0 && value.length <= 63;
}
function IsLabel(value: string): boolean {
	return IsValidLabelLength(value) && (LabelPuny.IsPunyLabel(value) || LabelUnicode.IsUnicodeLabel(value));
}
// ------------------------------------------------------------------
// NormalizeHostname
//
// Normalizes a hostname for label validation. Maps fullwidth
// codepoints to their ASCII equivalent (e.g. 'ａ' U+FF41 maps to
// 'a'), then normalizes for NFC such that equivalent codepoint
// sequences can be uniformly compared. It also removes codepoints
// that IDNA mapping ignores, and converts full stop variants to
// ASCII '.' so the hostname can be split into labels.
// ------------------------------------------------------------------
function NormalizeHostname(value: string): string {
	return (
		value
			.replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)) // RE_FULLWIDTH_MAPPING
			.normalize("NFC")
			// biome-ignore lint/suspicious/noMisleadingCharacterClass: a set of single code points to remove (u flag), by design.
			.replace(/[\u00ad\u034f\u180b-\u180d\u200b\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, "") // RE_IGNORED_MAPPING
			.replace(/[\u002E\u3002\uFF0E\uFF61]/g, ".")
	); // RE_FULL_STOP_MAPPING
}
// ------------------------------------------------------------------
// IsIdnHostname
// ------------------------------------------------------------------
export function IsIdnHostname(value: string): boolean {
	if (value.length === 0 || value.includes(" ")) return false;
	const normalized = NormalizeHostname(value);
	if (normalized.length > 253) return false;
	const labels = normalized.split(".");
	const hasBidiChars = labels.some((label) => FormatBidi.HasBidiChars(label));
	return labels.every((label) => IsLabel(label) && (!hasBidiChars || FormatBidi.SatisfiesBidiRule(label)));
}
