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

import * as FormatPuny from "../format/puny.ts";
import * as Pattern from "../pattern/pattern.ts";
import * as LabelUnicode from "./unicode.ts";

// ------------------------------------------------------------------
// IsPunyLabel
// ------------------------------------------------------------------
export function IsPunyLabel(value: string): boolean {
	if (!FormatPuny.IsAcePrefixed(value)) return false;
	try {
		const body = value.slice(4).toLowerCase();
		// A payload consisting of only a hyphen, or starting with the delimiter
		// (like "-9uc"), has 0 basic ASCII characters preceding it and is malformed.
		if (body.lastIndexOf("-") === 0) return false;
		const decoded = FormatPuny.Decode(body);
		// RFC 5890 §2.3.2.1 - a U-label must contain at least one non-ASCII
		// character. Code-unit level check: any non-ASCII codepoint has at least
		// one UTF-16 unit >= 0x80 (surrogate halves included), so no need to
		// decode codepoints or allocate a character array to answer this.
		if (!Pattern.RE_NON_ASCII.test(decoded)) return false;
		return LabelUnicode.IsUnicodeLabel(decoded);
	} catch {
		return false;
	}
}
