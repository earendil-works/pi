/**
 * Tutorial 3: Display-Line Vertical Navigation
 *
 * Implement up/down movement through wrapped text.
 * This demonstrates the "sticky column" concept (targetDisplayCol).
 *
 * Run: npx tsx packages/tui/docs/tutorials/03-vertical-navigation.ts
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
	targetDisplayCol: number | undefined; // Sticky column for vertical moves
}

// =============================================================================
// TEXT BUFFER WITH NAVIGATION
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

	// Find which display slice the cursor is in
	findCurrentDisplayLine(): number {
		const { bufferLine, bufferCol } = this.cursor;

		// Find all slices for current buffer line
		const slicesForLine: number[] = [];
		for (let i = 0; i < this.slices.length; i++) {
			if (this.slices[i]?.bufferLine === bufferLine) {
				slicesForLine.push(i);
			}
		}

		if (slicesForLine.length === 0) return 0;

		// Find which slice contains the cursor
		for (const idx of slicesForLine) {
			const slice = this.slices[idx];
			if (!slice) continue;

			const isLast = idx === slicesForLine[slicesForLine.length - 1];

			// Last slice can include endCol; others are exclusive
			const inRange = isLast
				? bufferCol >= slice.startCol && bufferCol <= slice.endCol
				: bufferCol >= slice.startCol && bufferCol < slice.endCol;

			if (inRange) return idx;
		}

		return slicesForLine[slicesForLine.length - 1] ?? 0;
	}

	// Move cursor vertically through DISPLAY lines (not buffer lines)
	moveVertical(delta: number): string {
		const currentIdx = this.findCurrentDisplayLine();
		const currentSlice = this.slices[currentIdx];
		if (!currentSlice) return "No current slice";

		// Calculate current display column
		const currentDisplayCol = this.cursor.bufferCol - currentSlice.startCol;

		// Initialize sticky column on first vertical move
		if (this.cursor.targetDisplayCol === undefined) {
			this.cursor.targetDisplayCol = currentDisplayCol;
		}

		// Calculate new display line index
		const newIdx = currentIdx + delta;
		if (newIdx < 0) return "Already at top";
		if (newIdx >= this.slices.length) return "Already at bottom";

		const newSlice = this.slices[newIdx];
		if (!newSlice) return "Invalid slice";

		const sliceLength = newSlice.endCol - newSlice.startCol;

		// Is this the last slice for its buffer line?
		const nextSlice = this.slices[newIdx + 1];
		const isLastForLine = newIdx === this.slices.length - 1 || !nextSlice || nextSlice.bufferLine !== newSlice.bufferLine;

		// Clamp target column to valid range
		// Non-last slices: can go to sliceLength-1 (to avoid landing on boundary)
		// Last slice: can go to sliceLength (end-of-line position)
		const maxCol = isLastForLine ? sliceLength : Math.max(0, sliceLength - 1);
		const targetCol = Math.min(this.cursor.targetDisplayCol, maxCol);

		// Update cursor position
		const oldLine = this.cursor.bufferLine;
		const oldCol = this.cursor.bufferCol;

		this.cursor.bufferLine = newSlice.bufferLine;
		this.cursor.bufferCol = newSlice.startCol + targetCol;

		return `Moved from (${oldLine},${oldCol}) to (${this.cursor.bufferLine},${this.cursor.bufferCol}), ` +
			`target col ${this.cursor.targetDisplayCol} → actual col ${targetCol}`;
	}

	// Clear sticky column (called on horizontal moves, typing, etc.)
	clearTargetColumn(): void {
		this.cursor.targetDisplayCol = undefined;
	}

	// Visual display with cursor
	display(): void {
		const currentDisplayLine = this.findCurrentDisplayLine();

		console.log(`┌${"─".repeat(this.width)}┐`);

		for (let i = 0; i < this.slices.length; i++) {
			const slice = this.slices[i];
			if (!slice) continue;

			let line = slice.text.padEnd(this.width);

			// Show cursor on current display line
			if (i === currentDisplayLine) {
				const visualCol = this.cursor.bufferCol - slice.startCol;
				const before = line.slice(0, visualCol);
				const cursorChar = line[visualCol] ?? " ";
				const after = line.slice(visualCol + 1);
				// Reverse video for cursor
				line = before + `\x1b[7m${cursorChar}\x1b[0m` + after;
			}

			// Mark buffer line boundaries
			const nextSlice = this.slices[i + 1];
			const isLastForLine = i === this.slices.length - 1 || !nextSlice || nextSlice.bufferLine !== slice.bufferLine;
			const marker = isLastForLine ? `buf${slice.bufferLine}` : "  │";

			console.log(`│${line}│ ${marker}`);
		}

		console.log(`└${"─".repeat(this.width)}┘`);
		console.log(
			`Cursor: buffer(${this.cursor.bufferLine}, ${this.cursor.bufferCol})  ` +
				`Sticky column: ${this.cursor.targetDisplayCol ?? "none"}`,
		);
	}
}

// =============================================================================
// INTERACTIVE DEMO
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║              VERTICAL NAVIGATION DEMO                            ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

// Create a buffer with text that will wrap
const buffer = new TextBuffer("abcdefghijklmnopqrstuvwxyz\n123");
buffer.layout(10);

console.log("Text: 'abcdefghijklmnopqrstuvwxyz' + newline + '123'");
console.log("Width: 10 columns");
console.log();

console.log("═══ INITIAL STATE ═══");
buffer.display();
console.log();

// Move to column 5
buffer.cursor.bufferCol = 5;
console.log("═══ MOVED TO COLUMN 5 (on 'f') ═══");
buffer.display();
console.log();

// Move down
console.log("═══ PRESS DOWN ═══");
const result1 = buffer.moveVertical(1);
console.log(`Result: ${result1}`);
buffer.display();
console.log();

console.log("Notice: targetDisplayCol is now 5 (sticky column)");
console.log("Cursor moved to second display line, still at visual column 5");
console.log();

// Move down again
console.log("═══ PRESS DOWN AGAIN ═══");
const result2 = buffer.moveVertical(1);
console.log(`Result: ${result2}`);
buffer.display();
console.log();

console.log("Notice: Third display line (uvwxyz) only has 6 chars.");
console.log("Target was 5, which is valid, so cursor is at visual column 5.");
console.log();

// Move down to next buffer line
console.log("═══ PRESS DOWN TO NEXT BUFFER LINE ═══");
const result3 = buffer.moveVertical(1);
console.log(`Result: ${result3}`);
buffer.display();
console.log();

console.log("Notice: Buffer line 1 ('123') only has 3 chars.");
console.log("Target column 5 > 3, so cursor is clamped to end (column 3).");
console.log("But targetDisplayCol is STILL 5! This is the 'sticky column'.");
console.log();

// Move back up
console.log("═══ PRESS UP ═══");
const result4 = buffer.moveVertical(-1);
console.log(`Result: ${result4}`);
buffer.display();
console.log();

console.log("Notice: Moving back up, the cursor returns to column 5!");
console.log("This is because targetDisplayCol was preserved.");
console.log();

// =============================================================================
// COMPARISON: LOGICAL VS DISPLAY NAVIGATION
// =============================================================================

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║     LOGICAL (j/k) vs DISPLAY (gj/gk) NAVIGATION                  ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

console.log("In Vim:");
console.log("  j/k  = move by BUFFER lines (skip wrapped display lines)");
console.log("  gj/gk = move by DISPLAY lines (what you see on screen)");
console.log();

console.log("Our implementation uses DISPLAY navigation by default.");
console.log("This feels more natural for most users editing wrapped text.");
console.log();

console.log("Example with text 'abcdefghijklmnopqrstuvwxyz' at width 10:");
console.log();
console.log("  DISPLAY view:          If cursor is on 'f' and user presses DOWN:");
console.log("  ┌──────────┐");
console.log("  │abcdefghij│           LOGICAL (j): jumps to buffer line 1 ('123')");
console.log("  │klmnopqrst│ ←────────DISPLAY (gj): moves here (visual column 5 = 'p')");
console.log("  │uvwxyz    │");
console.log("  │123       │ ←────────LOGICAL would skip to here!");
console.log("  └──────────┘");
