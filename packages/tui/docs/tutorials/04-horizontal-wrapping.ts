/**
 * Tutorial 4: Horizontal Movement at Wrap Boundaries
 *
 * Demonstrates what happens when you press ← at the start of a wrapped line
 * or → at the end of a wrapped line.
 *
 * Run: npx tsx packages/tui/docs/tutorials/04-horizontal-wrapping.ts
 */

// =============================================================================
// DATA STRUCTURES
// =============================================================================

interface DisplaySlice {
	text: string;
	bufferLine: number;
	startCol: number;
	endCol: number;
}

interface CursorState {
	bufferLine: number;
	bufferCol: number;
	targetDisplayCol: number | undefined;
}

// =============================================================================
// TEXT BUFFER WITH HORIZONTAL NAVIGATION
// =============================================================================

class TextBuffer {
	lines: string[];
	cursor: CursorState;
	slices: DisplaySlice[] = [];
	width: number = 0;

	constructor(text: string) {
		this.lines = text.split("\n");
		this.cursor = { bufferLine: 0, bufferCol: 0, targetDisplayCol: undefined };
	}

	layout(width: number): void {
		this.width = width;
		this.slices = [];

		for (let bufferLine = 0; bufferLine < this.lines.length; bufferLine++) {
			const line = this.lines[bufferLine] ?? "";

			if (line.length <= width) {
				this.slices.push({ text: line, bufferLine, startCol: 0, endCol: line.length });
			} else {
				for (let pos = 0; pos < line.length; pos += width) {
					this.slices.push({
						text: line.slice(pos, pos + width),
						bufferLine,
						startCol: pos,
						endCol: Math.min(pos + width, line.length),
					});
				}
			}
		}
	}

	findCurrentDisplayLine(): number {
		const { bufferLine, bufferCol } = this.cursor;
		const slicesForLine: number[] = [];

		for (let i = 0; i < this.slices.length; i++) {
			if (this.slices[i]?.bufferLine === bufferLine) {
				slicesForLine.push(i);
			}
		}

		if (slicesForLine.length === 0) return 0;

		for (const idx of slicesForLine) {
			const slice = this.slices[idx];
			if (!slice) continue;

			const isLast = idx === slicesForLine[slicesForLine.length - 1];
			const inRange = isLast
				? bufferCol >= slice.startCol && bufferCol <= slice.endCol
				: bufferCol >= slice.startCol && bufferCol < slice.endCol;

			if (inRange) return idx;
		}

		return slicesForLine[slicesForLine.length - 1] ?? 0;
	}

	// Move cursor horizontally with wrap-around at display line boundaries
	moveHorizontal(delta: number): string {
		// Clear sticky column on any horizontal movement
		this.cursor.targetDisplayCol = undefined;

		const currentIdx = this.findCurrentDisplayLine();
		const currentSlice = this.slices[currentIdx];
		if (!currentSlice) return "No current slice";

		const oldCol = this.cursor.bufferCol;

		if (delta < 0) {
			// Moving LEFT
			if (this.cursor.bufferCol > currentSlice.startCol) {
				// Normal case: just move left within slice
				this.cursor.bufferCol += delta;
				return `Left within slice: ${oldCol} → ${this.cursor.bufferCol}`;
			} else if (currentIdx > 0) {
				// At start of display line: wrap to end of PREVIOUS display line
				const prevSlice = this.slices[currentIdx - 1];
				if (!prevSlice) return "No previous slice";

				this.cursor.bufferLine = prevSlice.bufferLine;
				// Go to last character position (endCol - 1, since endCol is exclusive)
				this.cursor.bufferCol = Math.max(prevSlice.startCol, prevSlice.endCol - 1);

				return `Left wrap: moved to end of previous display line (pos ${this.cursor.bufferCol})`;
			} else {
				return "Already at start of text";
			}
		} else {
			// Moving RIGHT
			if (this.cursor.bufferCol < currentSlice.endCol) {
				// Normal case: just move right within slice
				this.cursor.bufferCol += delta;
				return `Right within slice: ${oldCol} → ${this.cursor.bufferCol}`;
			} else if (currentIdx < this.slices.length - 1) {
				// At end of display line: wrap to start of NEXT display line
				const nextSlice = this.slices[currentIdx + 1];
				if (!nextSlice) return "No next slice";

				this.cursor.bufferLine = nextSlice.bufferLine;
				this.cursor.bufferCol = nextSlice.startCol;

				return `Right wrap: moved to start of next display line (pos ${this.cursor.bufferCol})`;
			} else {
				return "Already at end of text";
			}
		}
	}

	display(): void {
		const currentDisplayLine = this.findCurrentDisplayLine();

		console.log(`┌${"─".repeat(this.width)}┐`);

		for (let i = 0; i < this.slices.length; i++) {
			const slice = this.slices[i];
			if (!slice) continue;

			let line = slice.text.padEnd(this.width);

			if (i === currentDisplayLine) {
				const visualCol = this.cursor.bufferCol - slice.startCol;
				const before = line.slice(0, visualCol);
				const cursorChar = line[visualCol] ?? " ";
				const after = line.slice(visualCol + 1);
				line = before + `\x1b[7m${cursorChar}\x1b[0m` + after;
			}

			// Show slice boundaries
			const marker = `[${slice.startCol}-${slice.endCol})`;
			console.log(`│${line}│ ${marker}`);
		}

		console.log(`└${"─".repeat(this.width)}┘`);
		console.log(`Cursor: buffer col ${this.cursor.bufferCol}`);
	}
}

// =============================================================================
// DEMO
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║            HORIZONTAL WRAPPING AT BOUNDARIES                     ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

const buffer = new TextBuffer("Hello World, this is Pi!");
buffer.layout(10);

console.log("Text: 'Hello World, this is Pi!' (24 chars)");
console.log("Width: 10 columns");
console.log("Slices: [0-10), [10-20), [20-24)");
console.log();

// Start at position 10 (boundary between display lines 0 and 1)
buffer.cursor.bufferCol = 10;

console.log("═══ CURSOR AT POSITION 10 (start of display line 1) ═══");
buffer.display();
console.log();

console.log("Position 10 is the 'd' in 'd, this is'");
console.log("It's at the START of display line 1 (second wrapped line)");
console.log();

// Press left - should wrap to end of display line 0
console.log("═══ PRESS LEFT ═══");
const result1 = buffer.moveHorizontal(-1);
console.log(`Result: ${result1}`);
buffer.display();
console.log();

console.log("The cursor wrapped to position 9 (end of display line 0)");
console.log("This is the last 'l' in 'Hello Worl'");
console.log();

// Move to position 9 and press right to go to 10
buffer.cursor.bufferCol = 9;
console.log("═══ CURSOR AT POSITION 9 (end of display line 0) ═══");
buffer.display();
console.log();

console.log("═══ PRESS RIGHT ═══");
const result2 = buffer.moveHorizontal(1);
console.log(`Result: ${result2}`);
buffer.display();
console.log();

console.log("The cursor wrapped to position 10 (start of display line 1)");
console.log();

// =============================================================================
// DETAILED BOUNDARY VISUALIZATION
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║              UNDERSTANDING WRAP BOUNDARIES                       ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("Buffer:    H e l l o   W o r l d ,   t h i s   i s   P i !");
console.log("Index:     0 1 2 3 4 5 6 7 8 9 ...   ...               ...");
console.log();
console.log("Display line 0: 'Hello Worl' (positions 0-9, slice [0,10))");
console.log("Display line 1: 'd, this is' (positions 10-19, slice [10,20))");
console.log("Display line 2: ' Pi!'       (positions 20-23, slice [20,24))");
console.log();

console.log("┌─────────────────────────────────────────────────────────────────┐");
console.log("│ WRAP LEFT at start of display line:                            │");
console.log("│                                                                 │");
console.log("│   Cursor at pos 10 (start of 'd, this is')                     │");
console.log("│   Press ← → goes to pos 9 (end of 'Hello Worl')                │");
console.log("│                                                                 │");
console.log("│   Calculation: previous_slice.endCol - 1 = 10 - 1 = 9          │");
console.log("│                (endCol is exclusive, so -1 gets last char)     │");
console.log("└─────────────────────────────────────────────────────────────────┘");
console.log();

console.log("┌─────────────────────────────────────────────────────────────────┐");
console.log("│ WRAP RIGHT at end of display line:                             │");
console.log("│                                                                 │");
console.log("│   Cursor at pos 9 (end of 'Hello Worl')                        │");
console.log("│   Press → → goes to pos 10 (start of 'd, this is')             │");
console.log("│                                                                 │");
console.log("│   Calculation: next_slice.startCol = 10                        │");
console.log("└─────────────────────────────────────────────────────────────────┘");
console.log();

// =============================================================================
// EDGE CASES
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║                      EDGE CASES                                  ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("1. LEFT at position 0 (very start of text):");
buffer.cursor.bufferCol = 0;
const result3 = buffer.moveHorizontal(-1);
console.log(`   ${result3}`);
console.log();

console.log("2. RIGHT at position 24 (very end of text):");
buffer.cursor.bufferCol = 24;
const result4 = buffer.moveHorizontal(1);
console.log(`   ${result4}`);
console.log();

console.log("3. Normal movement within a slice:");
buffer.cursor.bufferCol = 5;
const result5 = buffer.moveHorizontal(1);
console.log(`   From pos 5: ${result5}`);
const result6 = buffer.moveHorizontal(-1);
console.log(`   From pos 6: ${result6}`);
