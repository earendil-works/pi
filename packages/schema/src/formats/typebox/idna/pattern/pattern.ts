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

// -------------------------------------------------------------------
// Validation Rules
// -------------------------------------------------------------------
export const RE_RULE_HYPHEN_PLACEMENT = /^(?!-).*(?<!-)$/;
export const RE_RULE_NOT_RESERVED_ACE = /^(?!..--)/;
export const RE_ASCII_LDH = /^[a-zA-Z0-9-]*$/;

// -------------------------------------------------------------------
// ASCII & Encoding
// -------------------------------------------------------------------
export const RE_ASCII = /^\p{ASCII}*$/u;
export const RE_NON_ASCII = /[^\p{ASCII}]/u;

// -------------------------------------------------------------------
// Structural & Unicode Controls
// -------------------------------------------------------------------
export const RE_HIGH_SURROGATE = /[\u{d800}-\u{dbff}]/u;
export const RE_REGIONAL_INDICATOR = /[\u{1f1e6}-\u{1f1ff}]/u;
export const RE_VARIATION_SELECTOR = /[\u{fe00}-\u{fe0f}]/u;
export const RE_ZERO_WIDTH_JOINER = /\u{200d}/u;

// -------------------------------------------------------------------
// Numbers & Digits
// -------------------------------------------------------------------
export const RE_ASCII_DIGIT = /[0-9]/;
export const RE_ARABIC_INDIC_DIGIT = /[\u{0660}-\u{0669}]/u;
export const RE_EXT_ARABIC_INDIC_DIGIT = /[\u{06f0}-\u{06f9}]/u;

// -------------------------------------------------------------------
// Separators
// -------------------------------------------------------------------
export const RE_COMMON_SEPARATOR = /[\u{002e}\u{002c}\u{003a}\u{002f}]/u;
export const RE_EUROPEAN_SEPARATOR = /[\u{002d}\u{002b}]/u;

// -------------------------------------------------------------------
// General Categories
// -------------------------------------------------------------------
export const RE_MARK_NONSPACING = /\p{Mn}/u;
export const RE_MARK_SPACING_COMBINING = /\p{Mc}/u;
export const RE_MARK_ENCLOSING = /\p{Me}/u;
export const RE_COMBINING_MARK = /[\p{Mn}\p{Mc}\p{Me}]/u;
export const RE_LETTER = /\p{L}/u;
export const RE_NUMBER_DECIMAL = /\p{Nd}/u;

// -------------------------------------------------------------------
// Scripts
// -------------------------------------------------------------------
export const RE_SCRIPT_GREEK = /\p{Script=Greek}/u;
export const RE_SCRIPT_HEBREW = /\p{Script=Hebrew}/u;
export const RE_SCRIPT_JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
export const RE_SCRIPT_ARABIC_LETTER = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Mandaic}]/u;

// -------------------------------------------------------------------
// RFC Specifications & Context Exceptions
// -------------------------------------------------------------------
export const RE_VIRAMA =
	/[\u{094d}\u{09cd}\u{0a4d}\u{0acd}\u{0b4d}\u{0bcd}\u{0c4d}\u{0ccd}\u{0d3b}\u{0d3c}\u{0d4d}\u{0dca}\u{1b44}\u{1baa}\u{1bab}\u{a9c0}\u{11046}\u{1107f}\u{110b9}\u{11133}\u{11134}\u{111c0}\u{11235}\u{1134d}\u{11442}\u{114c2}\u{115bf}\u{1163f}\u{116b6}\u{11c3f}\u{11d44}\u{11d45}]/u;
export const RE_RFC5892_DISALLOWED =
	/[\u{0640}\u{07fa}\u{302e}\u{302f}\u{3031}\u{3032}\u{3033}\u{3034}\u{3035}\u{303b}]/u;
// biome-ignore lint/suspicious/noMisleadingCharacterClass: a set of single code points (u flag), including ZWJ and ZWNJ, by design.
export const RE_CONTEXTO_EXCEPTIONS = /[\u{00b7}\u{0375}\u{05f3}\u{05f4}\u{200c}\u{200d}\u{30fb}]/u;
export const RE_PVALID_EXCEPTIONS = /[\u{00df}\u{03c2}\u{06fd}\u{06fe}\u{0f0b}\u{3007}]/u;

// -------------------------------------------------------------------
// Composite Patterns
// -------------------------------------------------------------------
export const RE_EUROPEAN_NUMBER = new RegExp(
	[RE_ASCII_DIGIT, RE_EXT_ARABIC_INDIC_DIGIT].map((regexp) => regexp.source).join("|"),
	"u",
);

export const RE_PERMITTED_CATEGORY = new RegExp(
	[
		RE_LETTER,
		RE_EUROPEAN_SEPARATOR,
		RE_COMMON_SEPARATOR,
		RE_NUMBER_DECIMAL,
		RE_MARK_NONSPACING,
		RE_MARK_SPACING_COMBINING,
		RE_CONTEXTO_EXCEPTIONS,
		RE_PVALID_EXCEPTIONS,
	]
		.map((regexp) => regexp.source)
		.join("|"),
	"u",
);
