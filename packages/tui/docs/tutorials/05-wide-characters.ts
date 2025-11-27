/**
 * Tutorial 5: Wide Characters and Emojis
 *
 * Not all characters are equal! Some take 2 terminal columns.
 * This tutorial shows why we need visibleWidth() instead of string.length.
 *
 * Run: npx tsx packages/tui/docs/tutorials/05-wide-characters.ts
 */

import stringWidth from "string-width";

// =============================================================================
// THE PROBLEM: CHARACTER WIDTH != STRING LENGTH
// =============================================================================

function visibleWidth(str: string): number {
	return stringWidth(str);
}

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║          WIDE CHARACTERS: LENGTH VS DISPLAY WIDTH                ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

const examples = [
	{ str: "abc", desc: "ASCII letters" },
	{ str: "你好", desc: "Chinese characters (CJK)" },
	{ str: "😀", desc: "Simple emoji" },
	{ str: "👨‍👩‍👧‍👦", desc: "Family emoji (ZWJ sequence)" },
	{ str: "🇯🇵", desc: "Flag emoji" },
	{ str: "Hello", desc: "5 ASCII chars" },
	{ str: "Hi😀", desc: "2 ASCII + 1 emoji" },
	{ str: "café", desc: "ASCII with accent (composed)" },
];

console.log("┌───────────────────────────────────────────────────────────────────┐");
console.log("│ String        │ .length │ visibleWidth │ Notes                    │");
console.log("├───────────────────────────────────────────────────────────────────┤");

for (const { str, desc } of examples) {
	const len = str.length.toString().padStart(7);
	const width = visibleWidth(str).toString().padStart(12);
	const paddedStr = ('"' + str + '"').padEnd(13);
	console.log(`│ ${paddedStr} │ ${len} │ ${width} │ ${desc.padEnd(24)} │`);
}

console.log("└───────────────────────────────────────────────────────────────────┘");
console.log();

// =============================================================================
// WHY THIS MATTERS FOR WRAPPING
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║              WHY THIS MATTERS FOR WRAPPING                       ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("Scenario: Terminal is 6 columns wide.");
console.log();

const text1 = "abcdef";
const text2 = "你好世";
const text3 = "😀😀😀";

console.log(`Text 1: "${text1}"  length=${text1.length}, width=${visibleWidth(text1)}`);
console.log(`Text 2: "${text2}"  length=${text2.length}, width=${visibleWidth(text2)}`);
console.log(`Text 3: "${text3}"  length=${text3.length}, width=${visibleWidth(text3)}`);
console.log();

console.log("All three have DIFFERENT string lengths but SAME display width (6)!");
console.log("They all fit exactly in a 6-column terminal.");
console.log();

// =============================================================================
// WRAPPING BY VISIBLE WIDTH
// =============================================================================

interface Slice {
	text: string;
	startCol: number;
	endCol: number;
}

// Grapheme segmenter for proper Unicode iteration
const segmenter = new Intl.Segmenter();

function wrapByVisibleWidth(line: string, maxWidth: number): Slice[] {
	const result: Slice[] = [];
	let currentText = "";
	let currentWidth = 0;
	let currentStart = 0;

	// Iterate by GRAPHEMES (not chars) to handle emoji sequences
	const graphemes = [...segmenter.segment(line)].map((s) => s.segment);

	let charIndex = 0;
	for (const grapheme of graphemes) {
		const graphemeWidth = visibleWidth(grapheme);

		// Would this grapheme exceed the width?
		if (currentWidth + graphemeWidth > maxWidth && currentText.length > 0) {
			// Save current slice
			result.push({
				text: currentText,
				startCol: currentStart,
				endCol: charIndex,
			});

			// Start new slice
			currentStart = charIndex;
			currentText = "";
			currentWidth = 0;
		}

		currentText += grapheme;
		currentWidth += graphemeWidth;
		charIndex += grapheme.length; // Note: grapheme.length may be > 1
	}

	// Don't forget the last slice
	if (currentText || result.length === 0) {
		result.push({
			text: currentText,
			startCol: currentStart,
			endCol: line.length,
		});
	}

	return result;
}

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║                 WRAPPING EMOJI TEXT                              ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

const emojiText = "😀😀😀😀😀😀";
console.log(`Text: "${emojiText}"`);
console.log(`String length: ${emojiText.length}`);
console.log(`Visible width: ${visibleWidth(emojiText)}`);
console.log();

const WIDTH = 6;
console.log(`Wrapping at width ${WIDTH}:`);
const slices = wrapByVisibleWidth(emojiText, WIDTH);

slices.forEach((slice, i) => {
	console.log(
		`  Slice ${i}: "${slice.text}" ` +
			`(width=${visibleWidth(slice.text)}, ` +
			`chars [${slice.startCol}, ${slice.endCol}))`,
	);
});
console.log();

// =============================================================================
// VISUAL DEMONSTRATION
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║              VISUAL: HOW IT LOOKS IN TERMINAL                    ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

function renderWrapped(text: string, width: number): void {
	const slices = wrapByVisibleWidth(text, width);

	console.log(`┌${"─".repeat(width)}┐`);
	for (const slice of slices) {
		const padding = " ".repeat(Math.max(0, width - visibleWidth(slice.text)));
		console.log(`│${slice.text}${padding}│`);
	}
	console.log(`└${"─".repeat(width)}┘`);
}

console.log("6 emojis at width 6 (each emoji = 2 cols, so 3 emojis per line):");
renderWrapped("😀😀😀😀😀😀", 6);
console.log();

console.log("Mixed content at width 10:");
renderWrapped("Hello 你好 😀 World!", 10);
console.log();

console.log("CJK text at width 8:");
renderWrapped("你好世界欢迎光临", 8);
console.log();

// =============================================================================
// THE GOTCHA: GRAPHEME CLUSTERS
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║              GRAPHEME CLUSTERS (THE HARD PART)                   ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("Some 'characters' are actually multiple code points:");
console.log();

const complexEmojis = [
	{ str: "👨‍👩‍👧‍👦", desc: "Family (man, woman, girl, boy joined with ZWJ)" },
	{ str: "👩‍💻", desc: "Woman technologist (woman + ZWJ + computer)" },
	{ str: "🏳️‍🌈", desc: "Rainbow flag (flag + ZWJ + rainbow)" },
	{ str: "🇺🇸", desc: "US flag (regional indicator U + regional indicator S)" },
];

for (const { str, desc } of complexEmojis) {
	const codePoints = [...str].length;
	console.log(`"${str}":`);
	console.log(`  Description: ${desc}`);
	console.log(`  .length = ${str.length} (UTF-16 code units)`);
	console.log(`  Code points = ${codePoints}`);
	console.log(`  visibleWidth = ${visibleWidth(str)} terminal columns`);
	console.log(`  Graphemes = 1 (it's ONE visual character!)`);
	console.log();
}

console.log("This is why we use Intl.Segmenter to iterate by graphemes,");
console.log("not by code points or code units!");
console.log();

// =============================================================================
// CURSOR POSITION IN EMOJI TEXT
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║           CURSOR NAVIGATION IN EMOJI TEXT                        ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

const emojiLine = "A😀B😀C";
console.log(`Text: "${emojiLine}"`);
console.log();

console.log("Character-by-character breakdown:");
const graphemes2 = [...segmenter.segment(emojiLine)];
let idx = 0;
for (const { segment } of graphemes2) {
	console.log(
		`  Index ${idx.toString().padStart(2)}: "${segment}" ` +
			`(length=${segment.length}, width=${visibleWidth(segment)})`,
	);
	idx += segment.length;
}
console.log();

console.log("Moving cursor RIGHT through this text:");
console.log("  Position 0: before 'A'");
console.log("  Position 1: before '😀' (after 'A')");
console.log("  Position 3: before 'B' (after '😀' - note: emoji.length=2)");
console.log("  Position 4: before '😀' (after 'B')");
console.log("  Position 6: before 'C' (after second '😀')");
console.log("  Position 7: at end (after 'C')");
console.log();

console.log("The cursor skips by GRAPHEME, not by index!");
console.log("When you press → on 'A', cursor goes from 0 to 1.");
console.log("When you press → on '😀', cursor goes from 1 to 3 (skips 2 indices).");
