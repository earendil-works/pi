/**
 * Tutorial 1: Buffer vs Display Positions
 *
 * This demonstrates the fundamental difference between where text lives
 * in memory (buffer) versus how it appears on screen (display).
 *
 * Run: npx tsx packages/tui/docs/tutorials/01-buffer-vs-display.ts
 */

// =============================================================================
// THE TEXT BUFFER
// =============================================================================
// The buffer is just an array of strings. It doesn't know about terminal width.

const textBuffer = {
	lines: ["Hello World, this is Pi!"],
	cursorLine: 0,
	cursorCol: 0,
};

// =============================================================================
// THE DISPLAY
// =============================================================================
// The display has a fixed width. Long lines must wrap.

const DISPLAY_WIDTH = 10;

function getDisplayLines(text: string, width: number): string[] {
	const result: string[] = [];
	for (let i = 0; i < text.length; i += width) {
		result.push(text.slice(i, i + width));
	}
	return result.length ? result : [""];
}

// =============================================================================
// VISUALIZATION
// =============================================================================

const line = textBuffer.lines[0] ?? "";
const displayLines = getDisplayLines(line, DISPLAY_WIDTH);

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║               BUFFER vs DISPLAY VISUALIZATION                    ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("┌─── BUFFER VIEW (how text is stored in memory) ───┐");
console.log(`│ Line 0: "${line}"`);
console.log(`│ Length: ${line.length} characters`);
console.log(`│`);
console.log(`│ Think of this as ONE continuous string.`);
console.log(`│ The buffer has no concept of "wrapping".`);
console.log("└──────────────────────────────────────────────────┘");
console.log();

console.log(`┌─── DISPLAY VIEW (width=${DISPLAY_WIDTH} columns) ───┐`);
displayLines.forEach((dl, i) => {
	// Show character indices above each display line
	const startIdx = i * DISPLAY_WIDTH;
	const indices = Array.from({ length: dl.length }, (_, j) => (startIdx + j) % 10).join("");
	console.log(`│ Indices: ${indices.padEnd(DISPLAY_WIDTH)}`);
	console.log(`│ Line ${i}:  "${dl.padEnd(DISPLAY_WIDTH)}"`);
	console.log(`│`);
});
console.log(`│ Total: ${displayLines.length} display lines from 1 buffer line`);
console.log("└─────────────────────────────────────────────────────┘");
console.log();

// =============================================================================
// COORDINATE CONVERSION
// =============================================================================

console.log("┌─── COORDINATE CONVERSION ───┐");
console.log("│");
console.log("│ Buffer position → Display position:");
console.log("│   displayLine = Math.floor(bufferCol / width)");
console.log("│   displayCol  = bufferCol % width");
console.log("│");
console.log("│ Display position → Buffer position:");
console.log("│   bufferCol = (displayLine * width) + displayCol");
console.log("│");
console.log("└─────────────────────────────────────────────────────┘");
console.log();

// Show examples
function showCursorPosition(bufferCol: number): void {
	const displayLine = Math.floor(bufferCol / DISPLAY_WIDTH);
	const displayCol = bufferCol % DISPLAY_WIDTH;
	const char = line[bufferCol] || "(end)";

	console.log(`  Buffer col ${bufferCol.toString().padStart(2)} → Display line ${displayLine}, col ${displayCol}`);
	console.log(`    Character: "${char}"`);
}

console.log("Examples:");
showCursorPosition(0);
showCursorPosition(5);
showCursorPosition(9); // Last char of display line 0
showCursorPosition(10); // First char of display line 1
showCursorPosition(12);
showCursorPosition(22);
showCursorPosition(24); // End of text

console.log();
console.log("═══════════════════════════════════════════════════════════════════");
console.log("KEY INSIGHT: Position 9 and 10 are adjacent in the buffer,");
console.log("but they appear on DIFFERENT display lines.");
console.log("This is why we need display-aware navigation!");
console.log("═══════════════════════════════════════════════════════════════════");
