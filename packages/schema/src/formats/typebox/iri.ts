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

// deno-lint-ignore-file no-control-regex

const IpvFutureMatchMaxLength = 2048;
const IpvFutureMatch = /\[[vV][0-9a-fA-F]+\.[^\]]+\]/; // Guarded By IpvFutureMatchMaxLength
const InvalidIriChars = /[\x00-\x20<>^`{|}\\]/;
const InvalidPercentEncoding = /%(?![0-9a-fA-F]{2})/;

// ------------------------------------------------------------------
// NarrowIpvFuture
//
// Substitutes an IPvFuture address with a standard IPv6 loopback
// address ([::1]). We do this because the native URL.canParse
// (WHATWG standard) rejects IPvFuture literals, which are
// otherwise valid in RFC 3987. Because regex substitution can
// be expensive on large strings, this operation is strictly
// limited to inputs under a defined length threshold.
//
// (review-optimization)
//
// ------------------------------------------------------------------
function NarrowIpvFuture(value: string): string {
	return value.length < IpvFutureMatchMaxLength ? value.replace(IpvFutureMatch, "[::1]") : value;
}
/**
 * Returns true if the value is a valid Internationalized Resource Identifier.
 * @specification https://datatracker.ietf.org/doc/html/rfc3987
 */
export function IsIri(value: string): boolean {
	// 1. Reject strings containing unencoded whitespace or illegal control characters.
	if (InvalidIriChars.test(value)) return false;
	// 2. Reject malformed percent-encoding triplets.
	if (InvalidPercentEncoding.test(value)) return false;
	// 3. Delegate to the native URL parser, patching the IPvFuture edge case beforehand.
	return URL.canParse(NarrowIpvFuture(value));
}
