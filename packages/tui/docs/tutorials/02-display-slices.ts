/**
 * Tutorial 2: Display Slice Mapping
 *
 * Learn how each display line maps back to buffer positions.
 * A "slice" is the key data structure for soft-wrap navigation.
 *
 * Run: npx tsx packages/tui/docs/tutorials/02-display-slices.ts
 */

// =============================================================================
// THE DISPLAY SLICE INTERFACE
// =============================================================================

interface DisplaySlice {
	text: string; // What's shown on this display line
	bufferLine: number; // Which logical line it came from
	startCol: number; // Buffer column where this slice starts (INCLUSIVE)
	endCol: number; // Buffer column where this slice ends (EXCLUSIVE!)
}

// =============================================================================
// BUILDING SLICES
// =============================================================================

function buildDisplaySlices(lines: string[], width: number): DisplaySlice[] {
	const slices: DisplaySlice[] = [];

	for (let bufferLine = 0; bufferLine < lines.length; bufferLine++) {
		const line = lines[bufferLine] ?? "";

		if (line.length <= width) {
			// Line fits without wrapping - one slice
			slices.push({
				text: line,
				bufferLine,
				startCol: 0,
				endCol: line.length,
			});
		} else {
			// Line needs wrapping - multiple slices
			for (let pos = 0; pos < line.length; pos += width) {
				const text = line.slice(pos, pos + width);
				slices.push({
					text,
					bufferLine,
					startCol: pos,
					endCol: Math.min(pos + width, line.length),
				});
			}
		}
	}

	return slices;
}

// =============================================================================
// DEMO: MULTIPLE LINES WITH WRAPPING
// =============================================================================

const lines = ["Hello World, this is a long line!", "Short", "Another moderately long line"];

const DISPLAY_WIDTH = 12;
const slices = buildDisplaySlices(lines, DISPLAY_WIDTH);

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║                    DISPLAY SLICE MAPPING                         ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("┌─── TEXT BUFFER ───┐");
lines.forEach((line, i) => {
	console.log(`│ Line ${i}: "${line}" (${line.length} chars)`);
});
console.log("└───────────────────┘");
console.log();

console.log(`┌─── DISPLAY SLICES (width=${DISPLAY_WIDTH}) ───┐`);
console.log("│");
slices.forEach((slice, i) => {
	const isLastForBufferLine =
		i === slices.length - 1 || (slices[i + 1] && slices[i + 1].bufferLine !== slice.bufferLine);

	console.log(
		`│ Slice[${i}]: "${slice.text.padEnd(DISPLAY_WIDTH)}" ` +
			`bufferLine=${slice.bufferLine}, ` +
			`cols=[${slice.startCol}, ${slice.endCol})` +
			(isLastForBufferLine ? " ← last for this line" : ""),
	);
});
console.log("│");
console.log("└─────────────────────────────────────────────────────────────────┘");
console.log();

// =============================================================================
// EXCLUSIVE END: WHY IT MATTERS
// =============================================================================

console.log("┌─── EXCLUSIVE END INDEX ───┐");
console.log("│");
console.log("│ Notice: endCol is EXCLUSIVE (like array slice, substring, etc.)");
console.log("│");
console.log("│ Example for 'Hello World, this is a long line!' at width 12:");
console.log("│");
console.log("│   Slice 0: [0, 12)  → contains positions 0-11");
console.log("│   Slice 1: [12, 24) → contains positions 12-23");
console.log("│   Slice 2: [24, 34) → contains positions 24-33 (line ends at 33)");
console.log("│");
console.log("│ Question: Where does cursor at position 12 belong?");
console.log("│   - It's NOT in [0, 12) because 12 is not < 12");
console.log("│   - It IS in [12, 24) because 12 >= 12 and 12 < 24");
console.log("│   → Position 12 belongs to Slice 1!");
console.log("│");
console.log("│ This prevents the cursor from 'landing on the crack'");
console.log("│ between display lines.");
console.log("│");
console.log("└─────────────────────────────────────────────────────────────────┘");
console.log();

// =============================================================================
// FINDING WHICH SLICE CONTAINS A CURSOR
// =============================================================================

function findSliceForCursor(slices: DisplaySlice[], bufferLine: number, bufferCol: number): number {
	// Find all slices for this buffer line
	const slicesForLine: number[] = [];
	for (let i = 0; i < slices.length; i++) {
		if (slices[i]?.bufferLine === bufferLine) {
			slicesForLine.push(i);
		}
	}

	if (slicesForLine.length === 0) return -1;

	// Check each slice
	for (const idx of slicesForLine) {
		const slice = slices[idx];
		if (!slice) continue;

		const isLastForLine = idx === slicesForLine[slicesForLine.length - 1];

		if (isLastForLine) {
			// Last slice: can include endCol (end-of-line cursor position)
			if (bufferCol >= slice.startCol && bufferCol <= slice.endCol) {
				return idx;
			}
		} else {
			// Non-last slice: exclusive end
			if (bufferCol >= slice.startCol && bufferCol < slice.endCol) {
				return idx;
			}
		}
	}

	// Fallback to last slice for this line
	return slicesForLine[slicesForLine.length - 1] ?? -1;
}

console.log("┌─── CURSOR POSITION LOOKUP ───┐");
console.log("│");

const testPositions = [
	{ line: 0, col: 0, desc: "Start of line 0" },
	{ line: 0, col: 11, desc: "End of slice 0 content" },
	{ line: 0, col: 12, desc: "BOUNDARY: should be slice 1, not 0" },
	{ line: 0, col: 24, desc: "BOUNDARY: should be slice 2" },
	{ line: 0, col: 33, desc: "End of buffer line 0" },
	{ line: 1, col: 0, desc: "Start of 'Short'" },
	{ line: 1, col: 5, desc: "End of 'Short'" },
	{ line: 2, col: 15, desc: "Middle of line 2" },
];

for (const pos of testPositions) {
	const sliceIdx = findSliceForCursor(slices, pos.line, pos.col);
	const slice = slices[sliceIdx];

	if (slice) {
		const visualCol = pos.col - slice.startCol;
		console.log(`│ Buffer(${pos.line}, ${pos.col.toString().padStart(2)}) → Slice[${sliceIdx}], visualCol=${visualCol}`);
		console.log(`│   ${pos.desc}`);
	}
}

console.log("│");
console.log("└─────────────────────────────────────────────────────────────────┘");
console.log();

// =============================================================================
// VISUAL REPRESENTATION
// =============================================================================

console.log("┌─── VISUAL: HOW SLICES MAP TO DISPLAY ───┐");
console.log(`│${"─".repeat(DISPLAY_WIDTH + 2)}│`);

let lastBufferLine = -1;
slices.forEach((slice, i) => {
	if (slice.bufferLine !== lastBufferLine) {
		if (lastBufferLine !== -1) {
			console.log(`│${"─".repeat(DISPLAY_WIDTH + 2)}│ ← buffer line boundary`);
		}
		lastBufferLine = slice.bufferLine;
	}

	// Show the slice with position markers
	const content = slice.text.padEnd(DISPLAY_WIDTH);
	console.log(`│ ${content} │ slice[${i}] buf(${slice.bufferLine}) [${slice.startCol},${slice.endCol})`);
});

console.log(`│${"─".repeat(DISPLAY_WIDTH + 2)}│`);
console.log("└─────────────────────────────────────────────────────────────────┘");
